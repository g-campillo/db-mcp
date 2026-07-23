package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"  // registers "pgx"
	_ "github.com/microsoft/go-mssqldb" // registers "sqlserver"
	_ "github.com/sijms/go-ora/v2"      // registers "oracle"
)

// DB wraps a *sql.DB with its connection's resolved config. Handles are
// opened lazily by Conn.Get (conn.go).
type DB struct {
	sql *sql.DB
	cfg *ConnConfig
}

func (db *DB) Close() error { return db.sql.Close() }

// QueryResult is the JSON-serialisable result returned to the agent.
type QueryResult struct {
	Columns         []string         `json:"columns,omitempty"`
	Rows            []map[string]any `json:"rows"`
	RowCount        int              `json:"row_count"`
	Truncated       bool             `json:"truncated,omitempty"`
	TruncatedReason string           `json:"truncated_reason,omitempty"`
	RowsAffected    *int64           `json:"rows_affected,omitempty"`
}

// RunRead executes a row-returning statement, capped at MaxRows.
func (db *DB) RunRead(ctx context.Context, query string) (*QueryResult, error) {
	return db.queryRows(ctx, query)
}

// RunWrite executes a non-row-returning statement and reports rows affected.
func (db *DB) RunWrite(ctx context.Context, query string) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, db.cfg.Timeout)
	defer cancel()
	r, err := db.sql.ExecContext(ctx, query)
	if err != nil {
		return nil, err
	}
	res := &QueryResult{Rows: []map[string]any{}}
	if n, err := r.RowsAffected(); err == nil {
		res.RowsAffected = &n
	}
	return res, nil
}

func (db *DB) queryRows(ctx context.Context, query string, args ...any) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, db.cfg.Timeout)
	defer cancel()
	rows, err := db.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows, db.cfg)
}

// scanRows drains a result set into a QueryResult, honouring the
// connection's row cap. Shared by the pool path (queryRows) and the
// dedicated-session paths (explain).
func scanRows(rows *sql.Rows, cfg *ConnConfig) (*QueryResult, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	res := &QueryResult{Columns: cols, Rows: []map[string]any{}}
	size := 0
	for rows.Next() {
		if len(res.Rows) >= cfg.MaxRows {
			res.Truncated = true
			res.TruncatedReason = "row limit"
			break
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = normalize(vals[i], cfg.MaxCellBytes)
		}
		res.Rows = append(res.Rows, m)
		if cfg.MaxResultBytes > 0 {
			// Approximate accounting: string lengths plus a flat 16 bytes
			// for every other value.
			for _, c := range cols {
				size += len(c)
				if s, ok := m[c].(string); ok {
					size += len(s)
				} else {
					size += 16
				}
			}
			if size > cfg.MaxResultBytes {
				res.Truncated = true
				res.TruncatedReason = "byte limit"
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res.RowCount = len(res.Rows)
	return res, nil
}

// normalize makes driver values JSON-friendly. maxCell caps string/[]byte
// cell size in bytes (-1 disables); oversized cells are cut with a marker
// so one CLOB cannot blow up a whole response.
func normalize(v any, maxCell int) any {
	var s string
	switch x := v.(type) {
	case []byte:
		s = string(x)
	case string:
		s = x
	case time.Time:
		return x.Format(time.RFC3339)
	default:
		return x
	}
	if maxCell > 0 && len(s) > maxCell {
		return strings.ToValidUTF8(s[:maxCell], "") + fmt.Sprintf("... [truncated, %d bytes total]", len(s))
	}
	return s
}

// ListTables lists tables and views, optionally filtered by schema/owner.
func (db *DB) ListTables(ctx context.Context, schema string) (*QueryResult, error) {
	var q string
	var args []any
	switch db.cfg.SQLDriver {
	case "pgx", "sqlserver":
		q = "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW')"
		if schema != "" {
			q += " AND table_schema = " + db.ph(1)
			args = append(args, schema)
		} else if db.cfg.SQLDriver == "pgx" {
			q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')"
		}
		q += " ORDER BY table_schema, table_name"
	case "oracle":
		// all_objects/user_objects covers tables and views in one query.
		// Materialised views are deliberately excluded.
		sel := "SELECT owner AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM all_objects WHERE object_type IN ('TABLE', 'VIEW')"
		if schema != "" {
			q = sel + " AND owner = " + db.ph(1) + " ORDER BY object_name"
			args = append(args, strings.ToUpper(schema))
		} else {
			q = "SELECT USER AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM user_objects WHERE object_type IN ('TABLE', 'VIEW') ORDER BY object_name"
		}
	}
	return db.queryRows(ctx, q, args...)
}

// catalogSection is one named catalog query inside a describe result.
type catalogSection struct {
	key  string
	q    string
	args []any
}

// addSchema appends an optional schema/owner filter clause with the next
// positional placeholder.
func (db *DB) addSchema(q string, args []any, clause, val string) (string, []any) {
	if val == "" {
		return q, args
	}
	return q + clause + db.ph(len(args)+1), append(args, val)
}

// DescribeTable returns column, PK/unique constraint, foreign-key (both
// directions) and index metadata for a table.
func (db *DB) DescribeTable(ctx context.Context, table, schema string) (map[string]any, error) {
	var secs []catalogSection
	switch db.cfg.SQLDriver {
	case "pgx":
		secs = db.pgDescribe(table, schema)
	case "sqlserver":
		secs = db.mssqlDescribe(table, schema)
	case "oracle":
		secs = db.oracleDescribe(strings.ToUpper(table), strings.ToUpper(schema))
	}
	out := map[string]any{}
	for _, s := range secs {
		res, err := db.queryRows(ctx, s.q, s.args...)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", s.key, err)
		}
		out[s.key] = res
	}
	return out, nil
}

func (db *DB) pgDescribe(table, schema string) []catalogSection {
	var secs []catalogSection

	q, args := "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_name = $1", []any{table}
	q, args = db.addSchema(q, args, " AND table_schema = ", schema)
	secs = append(secs, catalogSection{"columns", q + " ORDER BY ordinal_position", args})

	q, args = "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema WHERE tc.table_name = $1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')", []any{table}
	q, args = db.addSchema(q, args, " AND tc.table_schema = ", schema)
	secs = append(secs, catalogSection{"constraints", q + " ORDER BY tc.constraint_name, kcu.ordinal_position", args})

	const pgFK = "SELECT rc.constraint_name, kcu.table_schema AS from_schema, kcu.table_name AS from_table, kcu.column_name, kcu2.table_schema AS ref_schema, kcu2.table_name AS ref_table, kcu2.column_name AS ref_column FROM information_schema.referential_constraints rc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema JOIN information_schema.key_column_usage kcu2 ON kcu2.constraint_name = rc.unique_constraint_name AND kcu2.constraint_schema = rc.unique_constraint_schema AND kcu2.ordinal_position = kcu.position_in_unique_constraint"
	q, args = pgFK+" WHERE kcu.table_name = $1", []any{table}
	q, args = db.addSchema(q, args, " AND kcu.table_schema = ", schema)
	secs = append(secs, catalogSection{"foreign_keys", q + " ORDER BY rc.constraint_name, kcu.ordinal_position", args})

	q, args = pgFK+" WHERE kcu2.table_name = $1", []any{table}
	q, args = db.addSchema(q, args, " AND kcu2.table_schema = ", schema)
	secs = append(secs, catalogSection{"referenced_by", q + " ORDER BY rc.constraint_name, kcu.ordinal_position", args})

	q, args = "SELECT indexname AS index_name, indexdef AS definition FROM pg_indexes WHERE tablename = $1", []any{table}
	q, args = db.addSchema(q, args, " AND schemaname = ", schema)
	secs = append(secs, catalogSection{"indexes", q + " ORDER BY indexname", args})

	return secs
}

func (db *DB) mssqlDescribe(table, schema string) []catalogSection {
	var secs []catalogSection

	q, args := "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_name = @p1", []any{table}
	q, args = db.addSchema(q, args, " AND table_schema = ", schema)
	secs = append(secs, catalogSection{"columns", q + " ORDER BY ordinal_position", args})

	q, args = "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema WHERE tc.table_name = @p1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')", []any{table}
	q, args = db.addSchema(q, args, " AND tc.table_schema = ", schema)
	secs = append(secs, catalogSection{"constraints", q + " ORDER BY tc.constraint_name, kcu.ordinal_position", args})

	// information_schema cannot pair multi-column FKs reliably on SQL Server
	// (no position_in_unique_constraint), so use the sys catalog.
	const msFK = "SELECT fk.name AS constraint_name, SCHEMA_NAME(t.schema_id) AS from_schema, t.name AS from_table, pc.name AS column_name, SCHEMA_NAME(rt.schema_id) AS ref_schema, rt.name AS ref_table, rc.name AS ref_column FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id"
	q, args = msFK+" WHERE t.name = @p1", []any{table}
	q, args = db.addSchema(q, args, " AND SCHEMA_NAME(t.schema_id) = ", schema)
	secs = append(secs, catalogSection{"foreign_keys", q + " ORDER BY fk.name, fkc.constraint_column_id", args})

	q, args = msFK+" WHERE rt.name = @p1", []any{table}
	q, args = db.addSchema(q, args, " AND SCHEMA_NAME(rt.schema_id) = ", schema)
	secs = append(secs, catalogSection{"referenced_by", q + " ORDER BY fk.name, fkc.constraint_column_id", args})

	q, args = "SELECT i.name AS index_name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS column_name, ic.key_ordinal, ic.is_included_column FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.name IS NOT NULL AND t.name = @p1", []any{table}
	q, args = db.addSchema(q, args, " AND SCHEMA_NAME(t.schema_id) = ", schema)
	secs = append(secs, catalogSection{"indexes", q + " ORDER BY i.name, ic.key_ordinal", args})

	return secs
}

// oracleDescribe expects table and schema already upper-cased. With no
// schema it uses the user_* views (current user's objects), matching the
// list_tables convention; the referenced side of FK joins always uses all_*
// because a referenced constraint can belong to another owner.
func (db *DB) oracleDescribe(table, schema string) []catalogSection {
	var secs []catalogSection

	q, args := "SELECT column_name, data_type, nullable, data_length, data_precision, data_scale, data_default FROM all_tab_columns WHERE table_name = :1", []any{table}
	q, args = db.addSchema(q, args, " AND owner = ", schema)
	secs = append(secs, catalogSection{"columns", q + " ORDER BY column_id", args})

	if schema != "" {
		secs = append(secs,
			catalogSection{"constraints",
				"SELECT ac.constraint_name, ac.constraint_type, acc.column_name, acc.position FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name WHERE ac.table_name = :1 AND ac.constraint_type IN ('P', 'U') AND ac.owner = :2 ORDER BY ac.constraint_name, acc.position",
				[]any{table, schema}},
			catalogSection{"foreign_keys",
				"SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rc.owner AS ref_schema, rc.table_name AS ref_table, rcc.column_name AS ref_column FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE ac.constraint_type = 'R' AND ac.table_name = :1 AND ac.owner = :2 ORDER BY ac.constraint_name, acc.position",
				[]any{table, schema}},
			catalogSection{"referenced_by",
				"SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rcc.column_name AS ref_column FROM all_constraints rc JOIN all_constraints ac ON ac.r_owner = rc.owner AND ac.r_constraint_name = rc.constraint_name AND ac.constraint_type = 'R' JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE rc.table_name = :1 AND rc.owner = :2 ORDER BY ac.owner, ac.constraint_name, acc.position",
				[]any{table, schema}},
			catalogSection{"indexes",
				"SELECT ai.index_name, ai.uniqueness, aic.column_name, aic.column_position FROM all_indexes ai JOIN all_ind_columns aic ON aic.index_owner = ai.owner AND aic.index_name = ai.index_name WHERE ai.table_name = :1 AND ai.table_owner = :2 ORDER BY ai.index_name, aic.column_position",
				[]any{table, schema}})
		return secs
	}

	secs = append(secs,
		catalogSection{"constraints",
			"SELECT uc.constraint_name, uc.constraint_type, ucc.column_name, ucc.position FROM user_constraints uc JOIN user_cons_columns ucc ON ucc.constraint_name = uc.constraint_name WHERE uc.table_name = :1 AND uc.constraint_type IN ('P', 'U') ORDER BY uc.constraint_name, ucc.position",
			[]any{table}},
		catalogSection{"foreign_keys",
			"SELECT uc.constraint_name, USER AS from_schema, uc.table_name AS from_table, ucc.column_name, rc.owner AS ref_schema, rc.table_name AS ref_table, rcc.column_name AS ref_column FROM user_constraints uc JOIN user_cons_columns ucc ON ucc.constraint_name = uc.constraint_name JOIN all_constraints rc ON rc.owner = uc.r_owner AND rc.constraint_name = uc.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = ucc.position WHERE uc.constraint_type = 'R' AND uc.table_name = :1 ORDER BY uc.constraint_name, ucc.position",
			[]any{table}},
		catalogSection{"referenced_by",
			"SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rcc.column_name AS ref_column FROM all_constraints rc JOIN all_constraints ac ON ac.r_owner = rc.owner AND ac.r_constraint_name = rc.constraint_name AND ac.constraint_type = 'R' JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE rc.table_name = :1 AND rc.owner = USER ORDER BY ac.owner, ac.constraint_name, acc.position",
			[]any{table}},
		catalogSection{"indexes",
			"SELECT ui.index_name, ui.uniqueness, uic.column_name, uic.column_position FROM user_indexes ui JOIN user_ind_columns uic ON uic.index_name = ui.index_name WHERE ui.table_name = :1 ORDER BY ui.index_name, uic.column_position",
			[]any{table}})
	return secs
}

// SearchSchema finds tables and/or columns by case-insensitive name
// substring (SQL LIKE wildcards in the pattern pass through).
func (db *DB) SearchSchema(ctx context.Context, pattern, typ, schema string) (map[string]any, error) {
	out := map[string]any{}
	if typ == "" || typ == "table" {
		res, err := db.searchTables(ctx, pattern, schema)
		if err != nil {
			return nil, fmt.Errorf("tables: %w", err)
		}
		out["tables"] = res
	}
	if typ == "" || typ == "column" {
		res, err := db.searchColumns(ctx, pattern, schema)
		if err != nil {
			return nil, fmt.Errorf("columns: %w", err)
		}
		out["columns"] = res
	}
	return out, nil
}

func (db *DB) searchTables(ctx context.Context, pattern, schema string) (*QueryResult, error) {
	var q string
	var args []any
	switch db.cfg.SQLDriver {
	case "pgx", "sqlserver":
		like := "'%' || LOWER($1) || '%'"
		if db.cfg.SQLDriver == "sqlserver" {
			like = "'%' + LOWER(@p1) + '%'"
		}
		q, args = "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW') AND LOWER(table_name) LIKE "+like, []any{pattern}
		if schema != "" {
			q += " AND table_schema = " + db.ph(2)
			args = append(args, schema)
		} else if db.cfg.SQLDriver == "pgx" {
			q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')"
		}
		q += " ORDER BY table_schema, table_name"
	case "oracle":
		if schema != "" {
			q = "SELECT owner AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM all_objects WHERE object_type IN ('TABLE', 'VIEW') AND LOWER(object_name) LIKE '%' || LOWER(:1) || '%' AND owner = :2 ORDER BY owner, object_name"
			args = []any{pattern, strings.ToUpper(schema)}
		} else {
			q = "SELECT USER AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM user_objects WHERE object_type IN ('TABLE', 'VIEW') AND LOWER(object_name) LIKE '%' || LOWER(:1) || '%' ORDER BY object_name"
			args = []any{pattern}
		}
	}
	return db.queryRows(ctx, q, args...)
}

func (db *DB) searchColumns(ctx context.Context, pattern, schema string) (*QueryResult, error) {
	var q string
	var args []any
	switch db.cfg.SQLDriver {
	case "pgx", "sqlserver":
		like := "'%' || LOWER($1) || '%'"
		if db.cfg.SQLDriver == "sqlserver" {
			like = "'%' + LOWER(@p1) + '%'"
		}
		q, args = "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE LOWER(column_name) LIKE "+like, []any{pattern}
		if schema != "" {
			q += " AND table_schema = " + db.ph(2)
			args = append(args, schema)
		} else if db.cfg.SQLDriver == "pgx" {
			q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')"
		}
		q += " ORDER BY table_schema, table_name, ordinal_position"
	case "oracle":
		if schema != "" {
			q = "SELECT owner AS table_schema, table_name, column_name, data_type FROM all_tab_columns WHERE LOWER(column_name) LIKE '%' || LOWER(:1) || '%' AND owner = :2 ORDER BY owner, table_name, column_id"
			args = []any{pattern, strings.ToUpper(schema)}
		} else {
			q = "SELECT USER AS table_schema, table_name, column_name, data_type FROM user_tab_columns WHERE LOWER(column_name) LIKE '%' || LOWER(:1) || '%' ORDER BY table_name, column_id"
			args = []any{pattern}
		}
	}
	return db.queryRows(ctx, q, args...)
}

// Explain returns the engine's plan for a read statement without executing it.
func (db *DB) Explain(ctx context.Context, sqlText string) (*QueryResult, error) {
	switch db.cfg.SQLDriver {
	case "pgx":
		return db.queryRows(ctx, "EXPLAIN "+sqlText)
	case "oracle":
		return db.explainOracle(ctx, sqlText)
	case "sqlserver":
		return db.explainMSSQL(ctx, sqlText)
	}
	return nil, fmt.Errorf("explain is not supported for %s", db.cfg.DisplayName)
}

// explainOracle needs one session for both steps: PLAN_TABLE rows are
// session-private.
func (db *DB) explainOracle(ctx context.Context, sqlText string) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, db.cfg.Timeout)
	defer cancel()
	c, err := db.sql.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if _, err := c.ExecContext(ctx, "EXPLAIN PLAN FOR "+sqlText); err != nil {
		return nil, oracleExplainHint(err)
	}
	rows, err := c.QueryContext(ctx, "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())")
	if err != nil {
		return nil, oracleExplainHint(err)
	}
	defer rows.Close()
	return scanRows(rows, db.cfg)
}

func oracleExplainHint(err error) error {
	msg := err.Error()
	if strings.Contains(msg, "ORA-00942") || strings.Contains(msg, "ORA-02404") {
		return fmt.Errorf("%w (PLAN_TABLE appears unavailable for this user; a DBA can create it via $ORACLE_HOME/rdbms/admin/utlxplan.sql)", err)
	}
	return err
}

// explainMSSQL fetches the estimated plan via SHOWPLAN_ALL, which is sticky
// session state — so it runs on a dedicated session and the session is
// force-discarded if it cannot be switched back to normal mode.
func (db *DB) explainMSSQL(ctx context.Context, sqlText string) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, db.cfg.Timeout)
	defer cancel()
	c, err := db.sql.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if _, err := c.ExecContext(ctx, "SET SHOWPLAN_ALL ON"); err != nil {
		return nil, err
	}
	res, qErr := func() (*QueryResult, error) {
		rows, err := c.QueryContext(ctx, sqlText)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanRows(rows, db.cfg)
	}()
	if _, err := c.ExecContext(ctx, "SET SHOWPLAN_ALL OFF"); err != nil {
		// A session stuck in SHOWPLAN mode would return plans instead of data
		// to whoever gets it from the pool next: poison it so database/sql
		// throws the physical connection away.
		_ = c.Raw(func(any) error { return driver.ErrBadConn })
	}
	return res, qErr
}

// ph returns the driver-specific positional placeholder for argument n (1-based).
func (db *DB) ph(n int) string {
	switch db.cfg.SQLDriver {
	case "pgx":
		return fmt.Sprintf("$%d", n)
	case "sqlserver":
		return fmt.Sprintf("@p%d", n)
	case "oracle":
		return fmt.Sprintf(":%d", n)
	}
	return "?"
}

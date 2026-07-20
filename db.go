package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"  // registers "pgx"
	_ "github.com/microsoft/go-mssqldb" // registers "sqlserver"
	_ "github.com/sijms/go-ora/v2"      // registers "oracle"
)

// DB wraps a *sql.DB with the resolved config.
type DB struct {
	sql *sql.DB
	cfg *Config
}

// OpenDB connects and pings, failing fast on bad config.
func OpenDB(ctx context.Context, cfg *Config) (*DB, error) {
	sdb, err := sql.Open(cfg.Driver, cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", cfg.DisplayName, err)
	}
	sdb.SetMaxOpenConns(5)
	sdb.SetMaxIdleConns(2)
	sdb.SetConnMaxIdleTime(5 * time.Minute)

	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := sdb.PingContext(pctx); err != nil {
		sdb.Close()
		return nil, fmt.Errorf("connect to %s: %w", cfg.DisplayName, err)
	}
	return &DB{sql: sdb, cfg: cfg}, nil
}

func (db *DB) Close() error { return db.sql.Close() }

// QueryResult is the JSON-serialisable result returned to the agent.
type QueryResult struct {
	Columns      []string         `json:"columns,omitempty"`
	Rows         []map[string]any `json:"rows"`
	RowCount     int              `json:"row_count"`
	Truncated    bool             `json:"truncated,omitempty"`
	RowsAffected *int64           `json:"rows_affected,omitempty"`
}

// RunRead executes a row-returning statement, capped at MaxRows.
func (db *DB) RunRead(ctx context.Context, query string) (*QueryResult, error) {
	return db.queryRows(ctx, query)
}

// RunWrite executes a non-row-returning statement and reports rows affected.
func (db *DB) RunWrite(ctx context.Context, query string) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, db.cfg.QueryTimeout)
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
	ctx, cancel := context.WithTimeout(ctx, db.cfg.QueryTimeout)
	defer cancel()
	rows, err := db.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	res := &QueryResult{Columns: cols, Rows: []map[string]any{}}
	for rows.Next() {
		if len(res.Rows) >= db.cfg.MaxRows {
			res.Truncated = true
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
			m[c] = normalize(vals[i])
		}
		res.Rows = append(res.Rows, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res.RowCount = len(res.Rows)
	return res, nil
}

// normalize makes driver values JSON-friendly.
func normalize(v any) any {
	switch x := v.(type) {
	case []byte:
		return string(x)
	case time.Time:
		return x.Format(time.RFC3339)
	default:
		return x
	}
}

// ListTables lists base tables, optionally filtered by schema/owner.
func (db *DB) ListTables(ctx context.Context, schema string) (*QueryResult, error) {
	var q string
	var args []any
	switch db.cfg.Driver {
	case "pgx", "sqlserver":
		q = "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE'"
		if schema != "" {
			q += " AND table_schema = " + db.ph(1)
			args = append(args, schema)
		} else if db.cfg.Driver == "pgx" {
			q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')"
		}
		q += " ORDER BY table_schema, table_name"
	case "oracle":
		if schema != "" {
			q = "SELECT owner AS table_schema, table_name FROM all_tables WHERE owner = " + db.ph(1) + " ORDER BY owner, table_name"
			args = append(args, strings.ToUpper(schema))
		} else {
			q = "SELECT USER AS table_schema, table_name FROM user_tables ORDER BY table_name"
		}
	}
	return db.queryRows(ctx, q, args...)
}

// DescribeTable returns column metadata for a table.
func (db *DB) DescribeTable(ctx context.Context, table, schema string) (*QueryResult, error) {
	var q string
	var args []any
	switch db.cfg.Driver {
	case "pgx", "sqlserver":
		q = "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_name = " + db.ph(1)
		args = append(args, table)
		if schema != "" {
			q += " AND table_schema = " + db.ph(2)
			args = append(args, schema)
		}
		q += " ORDER BY ordinal_position"
	case "oracle":
		q = "SELECT column_name, data_type, nullable, data_length, data_precision, data_scale, data_default FROM all_tab_columns WHERE table_name = " + db.ph(1)
		args = append(args, strings.ToUpper(table))
		if schema != "" {
			q += " AND owner = " + db.ph(2)
			args = append(args, strings.ToUpper(schema))
		}
		q += " ORDER BY column_id"
	}
	return db.queryRows(ctx, q, args...)
}

// ph returns the driver-specific positional placeholder for argument n (1-based).
func (db *DB) ph(n int) string {
	switch db.cfg.Driver {
	case "pgx":
		return fmt.Sprintf("$%d", n)
	case "sqlserver":
		return fmt.Sprintf("@p%d", n)
	case "oracle":
		return fmt.Sprintf(":%d", n)
	}
	return "?"
}

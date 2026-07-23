package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type queryInput struct {
	SQL string `json:"sql" jsonschema:"the single SQL statement to execute"`
}

type schemaInput struct {
	Schema string `json:"schema,omitempty" jsonschema:"optional schema or owner to filter by"`
}

type describeInput struct {
	Table  string `json:"table" jsonschema:"the table name to describe"`
	Schema string `json:"schema,omitempty" jsonschema:"optional schema or owner of the table"`
}

type searchInput struct {
	Pattern string `json:"pattern" jsonschema:"case-insensitive name substring to find; SQL LIKE wildcards (% and _) also work"`
	Type    string `json:"type,omitempty" jsonschema:"restrict the search to 'table' or 'column'; omit to search both"`
	Schema  string `json:"schema,omitempty" jsonschema:"optional schema or owner to filter by"`
}

type explainInput struct {
	SQL string `json:"sql" jsonschema:"the read-only SQL statement to plan (it is not executed)"`
}

// connDescription names the one database this server serves and its permitted
// operations, appended to each tool description.
func connDescription(cfg *ConnConfig) string {
	target := cfg.Database
	if target == "" {
		target = cfg.OracleSID
	}
	if target != "" {
		target = " " + target
	}
	return fmt.Sprintf("Connection: %s%s (%s).", cfg.DisplayName, target, cfg.Perms)
}

// getDB opens the connection handle, mapping failure to a tool error result.
func getDB(ctx context.Context, conn *Conn) (*DB, *mcp.CallToolResult) {
	db, err := conn.Get(ctx)
	if err != nil {
		return nil, errorResult(fmt.Sprintf("connection %q unavailable: %v", conn.Cfg.Name, err))
	}
	return db, nil
}

// readGate returns an error result unless the connection permits reads.
func readGate(db *DB) *mcp.CallToolResult {
	if !db.cfg.Perms[OpRead] {
		return errorResult(fmt.Sprintf("read is not permitted on connection %q", db.cfg.Name))
	}
	return nil
}

// opsString renders the classified operations for audit records.
func opsString(ops []Op) string {
	parts := make([]string, len(ops))
	for i, o := range ops {
		parts[i] = string(o)
	}
	return strings.Join(parts, ",")
}

// runAudited executes fn, logs one audit record for the statement and
// returns fn's result.
func runAudited(aud *Auditor, db *DB, tool, sqlText string, ops []Op, fn func() (*QueryResult, error)) (*QueryResult, error) {
	start := time.Now()
	res, err := fn()
	rec := auditRecord{
		Connection: db.cfg.Name,
		Tool:       tool,
		Op:         opsString(ops),
		SQL:        sqlText,
		DurationMS: time.Since(start).Milliseconds(),
	}
	if res != nil {
		rows := res.RowCount
		rec.Rows = &rows
		rec.RowsAffected = res.RowsAffected
	}
	if err != nil {
		rec.Error = err.Error()
	}
	aud.Log(rec)
	return res, err
}

// RegisterTools wires the MCP tools onto the server for the one connection this
// process serves. There is no connection parameter and no way to reach any
// other database: the project's .mcp.json defines exactly this one.
func RegisterTools(server *mcp.Server, conn *Conn, aud *Auditor) {
	summary := connDescription(conn.Cfg)

	mcp.AddTool(server, &mcp.Tool{Name: "query", Description: "Execute a single SQL statement against the configured database. " +
		"Exactly one statement per call; DDL (CREATE/ALTER/DROP/TRUNCATE), MERGE and stored procedures are denied. " + summary},
		func(ctx context.Context, _ *mcp.CallToolRequest, in queryInput) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(in.SQL) == "" {
				return errorResult("sql is required"), nil, nil
			}
			db, errRes := getDB(ctx, conn)
			if errRes != nil {
				return errRes, nil, nil
			}
			ops, err := Authorize(in.SQL, db.cfg)
			if err != nil {
				return errorResult(err.Error()), nil, nil
			}
			return jsonResult(runAudited(aud, db, "query", in.SQL, ops, func() (*QueryResult, error) {
				if ReturnsRows(in.SQL, db.cfg.SQLDriver) {
					return db.RunRead(ctx, in.SQL)
				}
				return db.RunWrite(ctx, in.SQL)
			}))
		})

	mcp.AddTool(server, &mcp.Tool{Name: "list_tables", Description: "List base tables and views, optionally filtered by schema/owner. Requires read permission. " + summary},
		func(ctx context.Context, _ *mcp.CallToolRequest, in schemaInput) (*mcp.CallToolResult, any, error) {
			db, errRes := getDB(ctx, conn)
			if errRes != nil {
				return errRes, nil, nil
			}
			if errRes := readGate(db); errRes != nil {
				return errRes, nil, nil
			}
			return jsonResult(db.ListTables(ctx, in.Schema))
		})

	mcp.AddTool(server, &mcp.Tool{Name: "describe_table", Description: "Describe a table: columns, primary/unique constraints, foreign keys (both directions) and indexes. Requires read permission. " + summary},
		func(ctx context.Context, _ *mcp.CallToolRequest, in describeInput) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(in.Table) == "" {
				return errorResult("table is required"), nil, nil
			}
			db, errRes := getDB(ctx, conn)
			if errRes != nil {
				return errRes, nil, nil
			}
			if errRes := readGate(db); errRes != nil {
				return errRes, nil, nil
			}
			out, err := db.DescribeTable(ctx, in.Table, in.Schema)
			return jsonAnyResult(out, err)
		})

	mcp.AddTool(server, &mcp.Tool{Name: "search_schema", Description: "Find tables and columns by case-insensitive name substring (SQL LIKE wildcards % and _ pass through). Requires read permission. " + summary},
		func(ctx context.Context, _ *mcp.CallToolRequest, in searchInput) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(in.Pattern) == "" {
				return errorResult("pattern is required"), nil, nil
			}
			if in.Type != "" && in.Type != "table" && in.Type != "column" {
				return errorResult(`type must be "table" or "column" (or omitted for both)`), nil, nil
			}
			db, errRes := getDB(ctx, conn)
			if errRes != nil {
				return errRes, nil, nil
			}
			if errRes := readGate(db); errRes != nil {
				return errRes, nil, nil
			}
			out, err := db.SearchSchema(ctx, in.Pattern, in.Type, in.Schema)
			return jsonAnyResult(out, err)
		})

	mcp.AddTool(server, &mcp.Tool{Name: "explain", Description: "Show the execution plan for a read-only SQL statement without executing it (EXPLAIN / EXPLAIN PLAN / SHOWPLAN_ALL). Requires read permission. " + summary},
		func(ctx context.Context, _ *mcp.CallToolRequest, in explainInput) (*mcp.CallToolResult, any, error) {
			// Oracle rejects a trailing semicolon inside EXPLAIN PLAN FOR;
			// trimming is harmless on the other engines.
			sqlText := strings.TrimRight(strings.TrimSpace(in.SQL), "; \t\r\n")
			if sqlText == "" {
				return errorResult("sql is required"), nil, nil
			}
			db, errRes := getDB(ctx, conn)
			if errRes != nil {
				return errRes, nil, nil
			}
			if errRes := readGate(db); errRes != nil {
				return errRes, nil, nil
			}
			ops, err := Authorize(sqlText, db.cfg)
			if err != nil {
				return errorResult(err.Error()), nil, nil
			}
			if len(ops) != 1 || ops[0] != OpRead {
				return errorResult("explain only supports read statements"), nil, nil
			}
			return jsonResult(runAudited(aud, db, "explain", sqlText, ops, func() (*QueryResult, error) {
				return db.Explain(ctx, sqlText)
			}))
		})
}

func jsonResult(res *QueryResult, err error) (*mcp.CallToolResult, any, error) {
	return jsonAnyResult(res, err)
}

func jsonAnyResult(v any, err error) (*mcp.CallToolResult, any, error) {
	if err != nil {
		return errorResult("query failed: " + err.Error()), nil, nil
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return errorResult(err.Error()), nil, nil
	}
	return textResult(string(b)), nil, nil
}

func textResult(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg}}}
}

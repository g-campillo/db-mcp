package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

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

// RegisterTools wires the MCP tools onto the server, honouring permissions.
func RegisterTools(server *mcp.Server, db *DB) {
	perms := db.cfg.Perms

	desc := fmt.Sprintf(
		"Execute a single SQL statement against the %s database. "+
			"Permitted operations: %s. Exactly one statement per call; "+
			"DDL (CREATE/ALTER/DROP/TRUNCATE), MERGE and stored procedures are denied.",
		db.cfg.DisplayName, perms)

	mcp.AddTool(server, &mcp.Tool{Name: "query", Description: desc},
		func(ctx context.Context, _ *mcp.CallToolRequest, in queryInput) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(in.SQL) == "" {
				return errorResult("sql is required"), nil, nil
			}
			if _, err := Authorize(in.SQL, perms); err != nil {
				return errorResult(err.Error()), nil, nil
			}
			if ReturnsRows(in.SQL) {
				return jsonResult(db.RunRead(ctx, in.SQL))
			}
			return jsonResult(db.RunWrite(ctx, in.SQL))
		})

	if perms[OpRead] {
		mcp.AddTool(server, &mcp.Tool{Name: "list_tables", Description: "List base tables, optionally filtered by schema/owner."},
			func(ctx context.Context, _ *mcp.CallToolRequest, in schemaInput) (*mcp.CallToolResult, any, error) {
				return jsonResult(db.ListTables(ctx, in.Schema))
			})
		mcp.AddTool(server, &mcp.Tool{Name: "describe_table", Description: "Describe a table's columns and their types."},
			func(ctx context.Context, _ *mcp.CallToolRequest, in describeInput) (*mcp.CallToolResult, any, error) {
				if strings.TrimSpace(in.Table) == "" {
					return errorResult("table is required"), nil, nil
				}
				return jsonResult(db.DescribeTable(ctx, in.Table, in.Schema))
			})
	}
}

func jsonResult(res *QueryResult, err error) (*mcp.CallToolResult, any, error) {
	if err != nil {
		return errorResult("query failed: " + err.Error()), nil, nil
	}
	b, err := json.MarshalIndent(res, "", "  ")
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

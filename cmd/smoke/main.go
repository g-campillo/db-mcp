// Command smoke is an integration harness: it launches the db-mcp binary over
// stdio and exercises the tools against a live database.
//
//	smoke [binary]
//
// The child inherits the caller's DB_* environment. Set DB_DSN (or
// DB_DSN_CMD) to exercise the full-DSN path; otherwise use the discrete
// DB_HOST/DB_USER/DB_NAME fields.
//
// Prerequisites: a widgets(id, name) table and a connection granting
// read,create but NOT delete (the delete/drop steps assert denial).
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	bin := "./db-mcp"
	if len(os.Args) > 1 {
		bin = os.Args[1]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	cmd := exec.Command(bin)
	client := mcp.NewClient(&mcp.Implementation{Name: "smoke", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		fatal("connect: %v", err)
	}
	defer session.Close()

	lt, err := session.ListTools(ctx, nil)
	if err != nil {
		fatal("list tools: %v", err)
	}
	fmt.Print("tools:")
	for _, t := range lt.Tools {
		fmt.Printf(" %s", t.Name)
	}
	fmt.Println()

	steps := []struct {
		label    string
		tool     string
		args     map[string]any
		wantErr  bool   // true => we expect the permission gate to deny it
		wantText string // non-empty => output must contain this substring
	}{
		{"list_tables", "list_tables", map[string]any{}, false, ""},
		{"describe widgets", "describe_table", map[string]any{"table": "widgets"}, false, "constraints"},
		{"search schema", "search_schema", map[string]any{"pattern": "widg"}, false, "widgets"},
		{"explain", "explain", map[string]any{"sql": "SELECT id FROM widgets"}, false, ""},
		{"read", "query", map[string]any{"sql": "SELECT id, name FROM widgets ORDER BY id"}, false, ""},
		{"create (insert)", "query", map[string]any{"sql": "INSERT INTO widgets (id, name) VALUES (99, 'smoke')"}, false, ""},
		{"read after insert", "query", map[string]any{"sql": "SELECT id, name FROM widgets ORDER BY id"}, false, ""},
		{"db error surfaces cleanly", "query", map[string]any{"sql": "SELECT * FROM no_such_widget"}, true, ""},
		{"delete (should be denied)", "query", map[string]any{"sql": "DELETE FROM widgets WHERE id = 99"}, true, ""},
		{"unfiltered delete (should be denied)", "query", map[string]any{"sql": "DELETE FROM widgets"}, true, ""},
		{"drop (should be denied)", "query", map[string]any{"sql": "DROP TABLE widgets"}, true, ""},
	}

	fails := 0
	for _, s := range steps {
		res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: s.tool, Arguments: s.args})
		if err != nil {
			fmt.Printf("  [TRANSPORT-ERR] %s: %v\n", s.label, err)
			fails++
			continue
		}
		status := "OK"
		if res.IsError != s.wantErr {
			status = "UNEXPECTED"
			fails++
		} else if s.wantText != "" && !strings.Contains(textOf(res), s.wantText) {
			status = "MISSING " + s.wantText
			fails++
		}
		fmt.Printf("  [%s] %s -> %s\n", status, s.label, trunc(textOf(res), 240))
	}
	if fails > 0 {
		fatal("%d step(s) did not behave as expected", fails)
	}
	fmt.Println("ALL OK")
}

func textOf(res *mcp.CallToolResult) string {
	out := ""
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			out += tc.Text
		}
	}
	return out
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "SMOKE FAIL: "+format+"\n", a...)
	os.Exit(1)
}

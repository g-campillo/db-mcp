// Command smoke is an integration harness: it launches the db-mcp binary over
// stdio (inheriting DB_* env) and exercises the tools against a live database.
// Run it once per database with that database's env set. Not part of the server.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
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

	client := mcp.NewClient(&mcp.Implementation{Name: "smoke", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: exec.Command(bin)}, nil)
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
		label   string
		tool    string
		args    map[string]any
		wantErr bool // true => we expect the permission gate to deny it
	}{
		{"list_tables", "list_tables", map[string]any{}, false},
		{"describe widgets", "describe_table", map[string]any{"table": "widgets"}, false},
		{"read", "query", map[string]any{"sql": "SELECT id, name FROM widgets ORDER BY id"}, false},
		{"create (insert)", "query", map[string]any{"sql": "INSERT INTO widgets (id, name) VALUES (99, 'smoke')"}, false},
		{"read after insert", "query", map[string]any{"sql": "SELECT id, name FROM widgets ORDER BY id"}, false},
		{"delete (should be denied)", "query", map[string]any{"sql": "DELETE FROM widgets WHERE id = 99"}, true},
		{"drop (should be denied)", "query", map[string]any{"sql": "DROP TABLE widgets"}, true},
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

package main

import (
	"context"
	"log"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("db-mcp: ")

	// `db-mcp keychain ...` is the credential-management CLI. The MCP client
	// always launches the server with no arguments, so bare invocation serves.
	if len(os.Args) > 1 && os.Args[1] == "keychain" {
		os.Exit(runKeychainCLI(os.Args[2:]))
	}

	warnStaleGlobalConfig()

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatal(err)
	}

	// The connection opens lazily on first use, so startup only fails on bad
	// config — never on a database that happens to be down.
	conn := NewConn(cfg)
	defer conn.Close()

	aud, err := NewAuditor()
	if err != nil {
		log.Fatal(err)
	}
	defer aud.Close()

	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "db-mcp", Version: "0.3.0"}, nil)
	RegisterTools(server, conn, aud)

	// Serve over stdio until the client disconnects. Logs go to stderr, so they
	// never corrupt the JSON-RPC stream on stdout.
	if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

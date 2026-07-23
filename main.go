package main

import (
	"context"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("db-mcp: ")

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatal(err)
	}

	// Connections open lazily on first use, so startup only fails on bad
	// config — never on a database that happens to be down.
	reg := NewRegistry(cfg)
	defer reg.Close()

	aud, err := NewAuditor(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer aud.Close()

	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "db-mcp", Version: "0.2.0"}, nil)
	RegisterTools(server, reg, aud)

	// Serve over stdio until the client disconnects. Logs go to stderr, so they
	// never corrupt the JSON-RPC stream on stdout.
	if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

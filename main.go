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

	ctx := context.Background()
	db, err := OpenDB(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	server := mcp.NewServer(&mcp.Implementation{Name: "db-mcp", Version: "0.1.0"}, nil)
	RegisterTools(server, db)

	// Serve over stdio until the client disconnects. Logs go to stderr, so they
	// never corrupt the JSON-RPC stream on stdout.
	if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

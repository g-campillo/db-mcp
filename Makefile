# db-mcp build targets. `make install` produces ./db-mcp — the binary
# .mcp.json points at. go build only replaces it on a successful compile.

BINARY := db-mcp

install:
	go build -o $(BINARY) .

test:
	go vet ./...
	go test ./...

# Build the integration harness (needs the server binary too).
# Usage: ./smoke ./db-mcp [configfile] [connection] — see cmd/smoke/main.go.
smoke: install
	go build -o smoke ./cmd/smoke

clean:
	rm -f $(BINARY) smoke

.PHONY: install test smoke clean

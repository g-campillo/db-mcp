# db-mcp build targets.
#   make           -> build ./db-mcp in this directory
#   make install   -> build and copy db-mcp onto your PATH so .mcp.json can just
#                     say {"command": "db-mcp"}. Installs to PREFIX/bin
#                     (default /usr/local); uses sudo only if that dir needs it.
#                     No-sudo alternative: make install PREFIX=~/.local
#                     (ensure ~/.local/bin is on your PATH).

BINARY := db-mcp
PREFIX ?= /usr/local

build:
	go build -o $(BINARY) .

install: build
	mkdir -p $(PREFIX)/bin 2>/dev/null || sudo mkdir -p $(PREFIX)/bin
	install -m 0755 $(BINARY) $(PREFIX)/bin/ 2>/dev/null || sudo install -m 0755 $(BINARY) $(PREFIX)/bin/
	@echo "installed: $(PREFIX)/bin/$(BINARY)"

test:
	go vet ./...
	go test ./...

# Build the integration harness (needs the server binary too).
# Usage: env DB_DRIVER=... ./smoke ./db-mcp — see cmd/smoke/main.go.
smoke: build
	go build -o smoke ./cmd/smoke

clean:
	rm -f $(BINARY) smoke

.PHONY: build install test smoke clean

package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Auditor appends one JSONL record per agent-authored statement (the query
// and explain tools) to a log file. Introspection tools run fixed catalog
// SQL and are not audited; neither are authorization denials (nothing was
// executed). A nil *Auditor (auditing disabled) is safe to call.
type Auditor struct {
	mu sync.Mutex
	f  *os.File
}

type auditRecord struct {
	TS           string `json:"ts"`
	Connection   string `json:"connection"`
	Tool         string `json:"tool"`
	Op           string `json:"op"`
	SQL          string `json:"sql"`
	Rows         *int   `json:"rows,omitempty"`
	RowsAffected *int64 `json:"rows_affected,omitempty"`
	DurationMS   int64  `json:"duration_ms"`
	Error        string `json:"error,omitempty"`
}

// NewAuditor opens (or creates) the audit log, defaulting to
// <UserConfigDir>/db-mcp/audit.jsonl (override with DB_AUDIT_PATH). Returns nil
// when auditing is disabled via DB_AUDIT_DISABLED. Open failures are for the
// caller to treat as fatal: a safety feature that silently no-ops is worse than
// a crash at startup.
func NewAuditor() (*Auditor, error) {
	if v := strings.TrimSpace(os.Getenv("DB_AUDIT_DISABLED")); v != "" {
		if disabled, err := strconv.ParseBool(v); err == nil && disabled {
			return nil, nil
		}
	}
	path := strings.TrimSpace(os.Getenv("DB_AUDIT_PATH"))
	if path == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(dir, "db-mcp", "audit.jsonl")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &Auditor{f: f}, nil
}

// Log appends one record. Write errors go to stderr — never the MCP stdout
// stream. No per-line fsync and no rotation (v1): the OS flushes, and the
// file is plain JSONL for external tooling to rotate if ever needed.
func (a *Auditor) Log(rec auditRecord) {
	if a == nil {
		return
	}
	rec.TS = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(rec)
	if err != nil {
		log.Printf("audit: marshal: %v", err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := a.f.Write(append(b, '\n')); err != nil {
		log.Printf("audit: write: %v", err)
	}
}

func (a *Auditor) Close() {
	if a != nil {
		a.f.Close()
	}
}

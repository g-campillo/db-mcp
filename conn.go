package main

import (
	"context"
	"database/sql"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Conn is the configured connection with a lazily opened database handle.
type Conn struct {
	Cfg *ConnConfig
	mu  sync.Mutex
	db  *DB
}

func NewConn(cfg *ConnConfig) *Conn {
	return &Conn{Cfg: cfg}
}

// Get returns the cached handle, opening and pinging it on first use.
// Failures are not cached, so a database that was down is retried on the
// next call without restarting the server.
func (c *Conn) Get(ctx context.Context) (*DB, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db != nil {
		return c.db, nil
	}
	dsn, err := c.resolveDSN()
	if err != nil {
		return nil, err
	}
	sdb, err := sql.Open(c.Cfg.SQLDriver, dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", c.Cfg.DisplayName, err)
	}
	sdb.SetMaxOpenConns(5)
	sdb.SetMaxIdleConns(2)
	sdb.SetConnMaxIdleTime(5 * time.Minute)

	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := sdb.PingContext(pctx); err != nil {
		sdb.Close()
		return nil, fmt.Errorf("connect to %s: %w", c.Cfg.DisplayName, err)
	}
	c.db = &DB{sql: sdb, cfg: c.Cfg}
	return c.db, nil
}

// resolveDSN produces the connection string: a full DSN pulled from DB_DSN_CMD
// (e.g. macOS Keychain) or DB_DSN verbatim, otherwise assembled from the
// discrete fields with the password possibly coming from DB_PASSWORD_CMD.
func (c *Conn) resolveDSN() (string, error) {
	switch {
	case c.Cfg.DSNCmd != "":
		return runCmd(c.Cfg.DSNCmd, "dsn_cmd for "+c.Cfg.Name)
	case c.Cfg.DSN != "":
		return c.Cfg.DSN, nil
	}
	pass := c.Cfg.Password
	if c.Cfg.PasswordCmd != "" {
		p, err := runCmd(c.Cfg.PasswordCmd, "password_cmd for "+c.Cfg.Name)
		if err != nil {
			return "", err
		}
		pass = p
	}
	return buildDSN(c.Cfg.SQLDriver, c.Cfg.Host, c.Cfg.Port, c.Cfg.User, pass, c.Cfg.Database, c.Cfg.OracleSID)
}

// runCmd runs a shell command and returns its trimmed stdout, used to pull a
// secret (a password or a whole DSN) from the macOS Keychain via `security`.
func runCmd(cmd, label string) (string, error) {
	out, err := exec.Command("/bin/sh", "-c", cmd).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("%s: %v: %s", label, err, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("%s: %w", label, err)
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

func (c *Conn) Close() {
	c.mu.Lock()
	if c.db != nil {
		c.db.Close()
		c.db = nil
	}
	c.mu.Unlock()
}

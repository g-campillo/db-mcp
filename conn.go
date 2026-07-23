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

// Conn is one configured connection with a lazily opened database handle.
type Conn struct {
	Cfg *ConnConfig
	mu  sync.Mutex
	db  *DB
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
	pass := c.Cfg.Password
	if c.Cfg.PasswordCmd != "" {
		out, err := exec.Command("/bin/sh", "-c", c.Cfg.PasswordCmd).Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
				return nil, fmt.Errorf("password_cmd for %s: %v: %s", c.Cfg.Name, err, strings.TrimSpace(string(ee.Stderr)))
			}
			return nil, fmt.Errorf("password_cmd for %s: %w", c.Cfg.Name, err)
		}
		pass = strings.TrimRight(string(out), "\r\n")
	}
	dsn, err := buildDSN(c.Cfg.SQLDriver, c.Cfg.Host, c.Cfg.Port, c.Cfg.User, pass, c.Cfg.Database, c.Cfg.OracleSID)
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

// Registry holds all configured connections in file order.
type Registry struct {
	conns map[string]*Conn
	order []string
}

func NewRegistry(fc *FileConfig) *Registry {
	r := &Registry{conns: map[string]*Conn{}}
	for _, cc := range fc.Connections {
		r.conns[cc.Name] = &Conn{Cfg: cc}
		r.order = append(r.order, cc.Name)
	}
	return r
}

// Resolve maps a connection name to its Conn. An empty name is allowed only
// when exactly one connection is configured.
func (r *Registry) Resolve(name string) (*Conn, error) {
	if name == "" {
		if len(r.order) == 1 {
			return r.conns[r.order[0]], nil
		}
		return nil, fmt.Errorf("connection is required (available: %s)", strings.Join(r.order, ", "))
	}
	if c, ok := r.conns[name]; ok {
		return c, nil
	}
	return nil, fmt.Errorf("unknown connection %q (available: %s)", name, strings.Join(r.order, ", "))
}

func (r *Registry) Close() {
	for _, c := range r.conns {
		c.mu.Lock()
		if c.db != nil {
			c.db.Close()
			c.db = nil
		}
		c.mu.Unlock()
	}
}

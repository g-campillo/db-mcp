package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

// FileConfig is the multi-connection configuration loaded from a JSON file.
type FileConfig struct {
	Connections   []*ConnConfig `json:"connections"`
	AuditPath     string        `json:"audit_path"`
	AuditDisabled bool          `json:"audit_disabled"`
}

// ConnConfig is one named database connection: the JSON fields plus the
// resolved (non-serialised) driver, permissions and timeout.
type ConnConfig struct {
	Name                  string `json:"name"`
	Description           string `json:"description"`
	Driver                string `json:"driver"`
	Host                  string `json:"host"`
	Port                  int    `json:"port"`
	User                  string `json:"user"`
	Password              string `json:"password"`
	PasswordCmd           string `json:"password_cmd"`
	Database              string `json:"database"`
	OracleSID             string `json:"oracle_sid"`
	Permissions           string `json:"permissions"`
	MaxRows               int    `json:"max_rows"`
	QueryTimeout          string `json:"query_timeout"`
	AllowUnfilteredWrites bool   `json:"allow_unfiltered_writes"`
	MaxCellBytes          int    `json:"max_cell_bytes"`
	MaxResultBytes        int    `json:"max_result_bytes"`

	SQLDriver   string        `json:"-"` // database/sql driver name: pgx | sqlserver | oracle
	DisplayName string        `json:"-"` // user-facing driver label
	Perms       PermSet       `json:"-"`
	Timeout     time.Duration `json:"-"`
}

// loadConfig picks the configuration source: an explicit DB_MCP_CONFIG path
// (must exist), else the default config file if present, else legacy DB_* env.
func loadConfig(explicitPath, defaultPath string) (*FileConfig, error) {
	path := explicitPath
	if path == "" {
		path = defaultPath
	}
	if path != "" {
		data, err := os.ReadFile(path)
		switch {
		case err == nil:
			warnLoosePerms(path)
			return parseFileConfig(data)
		case explicitPath != "":
			return nil, fmt.Errorf("read config %s: %w", path, err)
		case !os.IsNotExist(err):
			return nil, fmt.Errorf("read config %s: %w", path, err)
		}
	}
	if strings.TrimSpace(os.Getenv("DB_DRIVER")) != "" {
		return legacyConfig()
	}
	return nil, fmt.Errorf("no configuration found: create %s or point DB_MCP_CONFIG at a config file (legacy DB_* env vars also still work)", path)
}

// legacyConfig synthesises a single connection named "default" from the v1
// DB_* environment variables, for backward compatibility.
func legacyConfig() (*FileConfig, error) {
	env := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }
	c := &ConnConfig{
		Name:         "default",
		Driver:       env("DB_DRIVER"),
		Host:         env("DB_HOST"),
		User:         env("DB_USER"),
		Password:     os.Getenv("DB_PASSWORD"), // never trim a password
		Database:     env("DB_NAME"),
		OracleSID:    env("DB_ORACLE_SID"),
		Permissions:  os.Getenv("DB_PERMISSIONS"),
		QueryTimeout: env("DB_QUERY_TIMEOUT"),
	}
	if ps := env("DB_PORT"); ps != "" {
		p, err := strconv.Atoi(ps)
		if err != nil || p <= 0 {
			return nil, fmt.Errorf("invalid DB_PORT %q", ps)
		}
		c.Port = p
	}
	if v := env("DB_MAX_ROWS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("invalid DB_MAX_ROWS %q", v)
		}
		c.MaxRows = n
	}
	if err := resolveConn(c); err != nil {
		return nil, err
	}
	return &FileConfig{Connections: []*ConnConfig{c}}, nil
}

// warnLoosePerms nags on stderr when a config file that may hold passwords is
// readable by group or other.
func warnLoosePerms(path string) {
	if fi, err := os.Stat(path); err == nil && fi.Mode().Perm()&0o044 != 0 {
		log.Printf("warning: config file %s is readable by group/other (mode %03o); consider chmod 600", path, fi.Mode().Perm())
	}
}

// parseFileConfig parses and validates the JSON config file contents.
func parseFileConfig(data []byte) (*FileConfig, error) {
	var fc FileConfig
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&fc); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if len(fc.Connections) == 0 {
		return nil, fmt.Errorf("config must define at least one connection")
	}
	seen := map[string]bool{}
	for i, c := range fc.Connections {
		if err := resolveConn(c); err != nil {
			label := c.Name
			if label == "" {
				label = fmt.Sprintf("#%d", i+1)
			}
			return nil, fmt.Errorf("connection %s: %w", label, err)
		}
		if seen[c.Name] {
			return nil, fmt.Errorf("duplicate connection name %q", c.Name)
		}
		seen[c.Name] = true
	}
	return &fc, nil
}

// resolveConn validates one connection entry and fills in the resolved fields
// (SQL driver name, defaults, parsed permissions and timeout).
func resolveConn(c *ConnConfig) error {
	if c.Name = strings.TrimSpace(c.Name); c.Name == "" {
		return fmt.Errorf("name is required")
	}
	var defPort int
	switch strings.ToLower(strings.TrimSpace(c.Driver)) {
	case "postgres", "postgresql":
		defPort, c.SQLDriver, c.DisplayName = 5432, "pgx", "postgres"
	case "sqlserver", "mssql":
		defPort, c.SQLDriver, c.DisplayName = 1433, "sqlserver", "sqlserver"
	case "oracle":
		defPort, c.SQLDriver, c.DisplayName = 1521, "oracle", "oracle"
	default:
		return fmt.Errorf("unsupported driver %q (use postgres, sqlserver or oracle)", c.Driver)
	}
	if c.Host = strings.TrimSpace(c.Host); c.Host == "" {
		return fmt.Errorf("host is required")
	}
	if c.User = strings.TrimSpace(c.User); c.User == "" {
		return fmt.Errorf("user is required")
	}
	if c.Port < 0 {
		return fmt.Errorf("invalid port %d", c.Port)
	}
	if c.Port == 0 {
		c.Port = defPort
	}
	if c.Password != "" && c.PasswordCmd != "" {
		return fmt.Errorf("password and password_cmd are mutually exclusive")
	}
	switch c.SQLDriver {
	case "pgx", "sqlserver":
		if strings.TrimSpace(c.Database) == "" {
			return fmt.Errorf("database is required for %s", c.DisplayName)
		}
	case "oracle":
		hasDB := strings.TrimSpace(c.Database) != ""
		hasSID := strings.TrimSpace(c.OracleSID) != ""
		if hasDB == hasSID {
			return fmt.Errorf("oracle requires exactly one of database (service name) or oracle_sid")
		}
	}
	perms, err := ParsePerms(c.Permissions)
	if err != nil {
		return err
	}
	c.Perms = perms
	if c.MaxRows < 0 {
		return fmt.Errorf("invalid max_rows %d", c.MaxRows)
	}
	if c.MaxRows == 0 {
		c.MaxRows = 500
	}
	c.Timeout = 30 * time.Second
	if c.QueryTimeout != "" {
		d, err := time.ParseDuration(c.QueryTimeout)
		if err != nil || d <= 0 {
			return fmt.Errorf("invalid query_timeout %q (use a Go duration like 30s)", c.QueryTimeout)
		}
		c.Timeout = d
	}
	if c.MaxCellBytes == 0 {
		c.MaxCellBytes = 8192
	}
	return nil
}

// LoadConfig resolves configuration from DB_MCP_CONFIG, the default config
// file, or legacy DB_* environment variables.
func LoadConfig() (*FileConfig, error) {
	return loadConfig(strings.TrimSpace(os.Getenv("DB_MCP_CONFIG")), defaultConfigPath())
}

func defaultConfigPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "db-mcp", "config.json")
}

// buildDSN assembles a driver-native connection string from discrete fields.
func buildDSN(sqlDriver, host string, port int, user, pass, name, sid string) (string, error) {
	hostport := fmt.Sprintf("%s:%d", host, port)
	switch sqlDriver {
	case "pgx":
		if name == "" {
			return "", fmt.Errorf("DB_NAME is required for postgres")
		}
		u := url.URL{Scheme: "postgres", User: url.UserPassword(user, pass), Host: hostport, Path: "/" + name}
		return u.String(), nil
	case "sqlserver":
		if name == "" {
			return "", fmt.Errorf("DB_NAME is required for sqlserver")
		}
		q := url.Values{}
		q.Set("database", name)
		u := url.URL{Scheme: "sqlserver", User: url.UserPassword(user, pass), Host: hostport, RawQuery: q.Encode()}
		return u.String(), nil
	case "oracle":
		if sid != "" {
			return go_ora.BuildUrl(host, port, "", user, pass, map[string]string{"SID": sid}), nil
		}
		if name == "" {
			return "", fmt.Errorf("oracle requires DB_NAME (service name) or DB_ORACLE_SID")
		}
		return go_ora.BuildUrl(host, port, name, user, pass, nil), nil
	}
	return "", fmt.Errorf("unknown driver %q", sqlDriver)
}

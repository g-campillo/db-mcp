package main

import (
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

// ConnConfig is the single database connection this process serves. Its fields
// come from the DB_* environment variables set in the project's local
// .mcp.json; the SQL driver name, parsed permissions and timeout are resolved.
type ConnConfig struct {
	Name                  string
	Driver                string
	Host                  string
	Port                  int
	User                  string
	Password              string
	PasswordCmd           string
	Database              string
	OracleSID             string
	DSN                   string // full driver-native connection string (bypasses buildDSN)
	DSNCmd                string // command whose stdout is the full DSN (e.g. macOS Keychain)
	Permissions           string
	MaxRows               int
	QueryTimeout          string
	AllowUnfilteredWrites bool
	MaxCellBytes          int
	MaxResultBytes        int

	SQLDriver   string        // database/sql driver name: pgx | sqlserver | oracle
	DisplayName string        // user-facing driver label
	Perms       PermSet       //
	Timeout     time.Duration //
}

// LoadConfig builds the one connection this process serves from the DB_*
// environment variables in the project's local .mcp.json. There is no
// machine-global config file: a project reaches exactly the database its own
// .mcp.json names, and nothing else.
func LoadConfig() (*ConnConfig, error) {
	env := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }
	if env("DB_DRIVER") == "" {
		return nil, fmt.Errorf("no database configured: set DB_DRIVER plus either DB_DSN_CMD (a command yielding the full connection string) or DB_HOST/DB_USER/DB_NAME in this project's .mcp.json env")
	}
	c := &ConnConfig{
		Name:         "default",
		Driver:       env("DB_DRIVER"),
		Host:         env("DB_HOST"),
		User:         env("DB_USER"),
		Password:     os.Getenv("DB_PASSWORD"), // never trim a password
		PasswordCmd:  env("DB_PASSWORD_CMD"),
		Database:     env("DB_NAME"),
		OracleSID:    env("DB_ORACLE_SID"),
		DSN:          env("DB_DSN"),
		DSNCmd:       env("DB_DSN_CMD"),
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
	if v := env("DB_ALLOW_UNFILTERED_WRITES"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("invalid DB_ALLOW_UNFILTERED_WRITES %q (use true/false)", v)
		}
		c.AllowUnfilteredWrites = b
	}
	if err := resolveConn(c); err != nil {
		return nil, err
	}
	return c, nil
}

// resolveConn validates the connection and fills in the resolved fields (SQL
// driver name, defaults, parsed permissions and timeout). In DSN mode the full
// connection string carries host/user/credentials, so those discrete fields are
// not required.
func resolveConn(c *ConnConfig) error {
	if c.Name = strings.TrimSpace(c.Name); c.Name == "" {
		c.Name = "default"
	}
	sqlDriver, displayName, defPort, ok := resolveDriver(c.Driver)
	if !ok {
		return fmt.Errorf("unsupported driver %q (use postgres, sqlserver or oracle)", c.Driver)
	}
	c.SQLDriver, c.DisplayName = sqlDriver, displayName

	if c.DSN != "" || c.DSNCmd != "" {
		if c.DSN != "" && c.DSNCmd != "" {
			return fmt.Errorf("DB_DSN and DB_DSN_CMD are mutually exclusive")
		}
		if c.Password != "" || c.PasswordCmd != "" {
			return fmt.Errorf("DB_DSN/DB_DSN_CMD carry the credentials, so cannot be combined with DB_PASSWORD/DB_PASSWORD_CMD")
		}
		_ = defPort // DSN mode ignores discrete host/port fields
	} else {
		if c.Host = strings.TrimSpace(c.Host); c.Host == "" {
			return fmt.Errorf("host is required (set DB_HOST, or use DB_DSN_CMD)")
		}
		if c.User = strings.TrimSpace(c.User); c.User == "" {
			return fmt.Errorf("user is required (set DB_USER, or use DB_DSN_CMD)")
		}
		if c.Port < 0 {
			return fmt.Errorf("invalid port %d", c.Port)
		}
		if c.Port == 0 {
			c.Port = defPort
		}
		if c.Password != "" && c.PasswordCmd != "" {
			return fmt.Errorf("DB_PASSWORD and DB_PASSWORD_CMD are mutually exclusive")
		}
		switch c.SQLDriver {
		case "pgx", "sqlserver":
			if strings.TrimSpace(c.Database) == "" {
				return fmt.Errorf("database is required for %s (set DB_NAME)", c.DisplayName)
			}
		case "oracle":
			hasDB := strings.TrimSpace(c.Database) != ""
			hasSID := strings.TrimSpace(c.OracleSID) != ""
			if hasDB == hasSID {
				return fmt.Errorf("oracle requires exactly one of DB_NAME (service name) or DB_ORACLE_SID")
			}
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

// warnStaleGlobalConfig nags once on stderr if the retired v2 machine-global
// config file is still on disk. It is no longer read: that ambient file let any
// project reach every connection listed in it. Credentials now live per-project
// in .mcp.json env plus the macOS Keychain.
func warnStaleGlobalConfig() {
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	path := filepath.Join(dir, "db-mcp", "config.json")
	if _, err := os.Stat(path); err == nil {
		log.Printf("warning: %s is no longer read; move each project's connection into its .mcp.json env (DB_DRIVER + DB_PERMISSIONS + DB_DSN_CMD) and delete this file", path)
	}
}

// resolveDriver maps a user-facing driver name/alias to the database/sql driver
// name, display label and default port. ok is false for an unknown driver.
func resolveDriver(driver string) (sqlDriver, displayName string, defPort int, ok bool) {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "postgres", "postgresql":
		return "pgx", "postgres", 5432, true
	case "sqlserver", "mssql":
		return "sqlserver", "sqlserver", 1433, true
	case "oracle":
		return "oracle", "oracle", 1521, true
	}
	return "", "", 0, false
}

// buildDSN assembles a driver-native connection string from discrete fields.
// Used only when DB_DSN/DB_DSN_CMD are not set.
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

package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

// Config is the resolved server configuration from environment variables.
type Config struct {
	Driver       string // database/sql driver name: pgx | sqlserver | oracle
	DisplayName  string // user-facing driver label (postgres | sqlserver | oracle)
	DSN          string
	Perms        PermSet
	MaxRows      int
	QueryTimeout time.Duration
}

// LoadConfig reads and validates configuration from the environment.
func LoadConfig() (*Config, error) {
	env := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }

	driver := strings.ToLower(env("DB_DRIVER"))
	host := env("DB_HOST")
	user := env("DB_USER")
	pass := os.Getenv("DB_PASSWORD") // never trim a password
	name := env("DB_NAME")
	sid := env("DB_ORACLE_SID")

	if driver == "" || host == "" || user == "" {
		return nil, fmt.Errorf("DB_DRIVER, DB_HOST and DB_USER are required")
	}

	var defPort int
	var sqlDriver string
	switch driver {
	case "postgres", "postgresql":
		defPort, sqlDriver = 5432, "pgx"
	case "sqlserver", "mssql":
		defPort, sqlDriver = 1433, "sqlserver"
	case "oracle":
		defPort, sqlDriver = 1521, "oracle"
	default:
		return nil, fmt.Errorf("unsupported DB_DRIVER %q (use postgres, sqlserver or oracle)", driver)
	}

	port := defPort
	if ps := env("DB_PORT"); ps != "" {
		p, err := strconv.Atoi(ps)
		if err != nil || p <= 0 {
			return nil, fmt.Errorf("invalid DB_PORT %q", ps)
		}
		port = p
	}

	dsn, err := buildDSN(sqlDriver, host, port, user, pass, name, sid)
	if err != nil {
		return nil, err
	}

	perms, err := ParsePerms(os.Getenv("DB_PERMISSIONS"))
	if err != nil {
		return nil, err
	}

	maxRows := 500
	if v := env("DB_MAX_ROWS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("invalid DB_MAX_ROWS %q", v)
		}
		maxRows = n
	}

	timeout := 30 * time.Second
	if v := env("DB_QUERY_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("invalid DB_QUERY_TIMEOUT %q (use a Go duration like 30s)", v)
		}
		timeout = d
	}

	return &Config{
		Driver:       sqlDriver,
		DisplayName:  driver,
		DSN:          dsn,
		Perms:        perms,
		MaxRows:      maxRows,
		QueryTimeout: timeout,
	}, nil
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

package main

import (
	"strings"
	"testing"
	"time"
)

func clearDBEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"DB_DRIVER", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_PASSWORD_CMD",
		"DB_NAME", "DB_ORACLE_SID", "DB_DSN", "DB_DSN_CMD", "DB_PERMISSIONS",
		"DB_MAX_ROWS", "DB_QUERY_TIMEOUT", "DB_ALLOW_UNFILTERED_WRITES",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadConfigEnvDiscrete(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DB_HOST", "envhost")
	t.Setenv("DB_USER", "envuser")
	t.Setenv("DB_PASSWORD", "trailing space ") // passwords are never trimmed
	t.Setenv("DB_NAME", "envdb")
	t.Setenv("DB_PERMISSIONS", "read,create")
	t.Setenv("DB_MAX_ROWS", "42")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if c.Name != "default" {
		t.Errorf("name = %q, want default", c.Name)
	}
	if c.SQLDriver != "pgx" || c.DisplayName != "postgres" || c.Host != "envhost" || c.Port != 5432 {
		t.Errorf("resolved (%s, %s, %s, %d)", c.SQLDriver, c.DisplayName, c.Host, c.Port)
	}
	if c.Password != "trailing space " {
		t.Errorf("password was trimmed: %q", c.Password)
	}
	if !c.Perms[OpRead] || !c.Perms[OpCreate] || c.Perms[OpDelete] {
		t.Errorf("perms = %v, want read,create", c.Perms)
	}
	if c.MaxRows != 42 {
		t.Errorf("MaxRows = %d, want 42", c.MaxRows)
	}
	if c.Timeout != 30*time.Second {
		t.Errorf("Timeout = %v, want default 30s", c.Timeout)
	}
	if c.MaxCellBytes != 8192 {
		t.Errorf("MaxCellBytes = %d, want default 8192", c.MaxCellBytes)
	}
}

func TestLoadConfigDriverAliases(t *testing.T) {
	cases := []struct {
		alias, sqlDriver string
		defPort          int
	}{
		{"postgres", "pgx", 5432},
		{"postgresql", "pgx", 5432},
		{"sqlserver", "sqlserver", 1433},
		{"mssql", "sqlserver", 1433},
		{"oracle", "oracle", 1521},
	}
	for _, c := range cases {
		t.Run(c.alias, func(t *testing.T) {
			clearDBEnv(t)
			t.Setenv("DB_DRIVER", c.alias)
			t.Setenv("DB_HOST", "h")
			t.Setenv("DB_USER", "u")
			if c.alias == "oracle" {
				t.Setenv("DB_ORACLE_SID", "X")
			} else {
				t.Setenv("DB_NAME", "d")
			}
			got, err := LoadConfig()
			if err != nil {
				t.Fatalf("%s: %v", c.alias, err)
			}
			if got.SQLDriver != c.sqlDriver || got.Port != c.defPort {
				t.Errorf("%s resolved to (%s, %d), want (%s, %d)", c.alias, got.SQLDriver, got.Port, c.sqlDriver, c.defPort)
			}
		})
	}
}

func TestLoadConfigDSNMode(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DB_DSN", "postgres://u:p@h:5432/d") // no discrete host/user/database needed
	t.Setenv("DB_PERMISSIONS", "read")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if c.DSN != "postgres://u:p@h:5432/d" {
		t.Errorf("DSN = %q, not preserved", c.DSN)
	}
	if c.SQLDriver != "pgx" {
		t.Errorf("SQLDriver = %q, want pgx", c.SQLDriver)
	}
	if c.Host != "" {
		t.Errorf("Host = %q, want empty in DSN mode", c.Host)
	}
}

func TestLoadConfigDSNCmdMode(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "oracle")
	// The command is NOT run at config-load time (only lazily on first Get),
	// so an arbitrary command still resolves the config cleanly.
	t.Setenv("DB_DSN_CMD", "security find-generic-password -s db-mcp/ora -w")
	t.Setenv("DB_PERMISSIONS", "read,create,update,delete")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if c.DSNCmd == "" {
		t.Error("DSNCmd lost in parsing")
	}
	if !c.Perms[OpDelete] {
		t.Errorf("perms = %v, want full crud", c.Perms)
	}
}

func TestLoadConfigAllowUnfilteredWrites(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DB_DSN", "postgres://u:p@h:5432/d")
	t.Setenv("DB_ALLOW_UNFILTERED_WRITES", "true")
	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !c.AllowUnfilteredWrites {
		t.Error("AllowUnfilteredWrites = false, want true")
	}
}

func TestLoadConfigErrors(t *testing.T) {
	cases := []struct {
		label   string
		env     map[string]string
		wantErr string
	}{
		{"missing driver", map[string]string{}, "db_driver"},
		{"bad driver", map[string]string{"DB_DRIVER": "mysql", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d"}, "driver"},
		{"discrete missing host", map[string]string{"DB_DRIVER": "postgres", "DB_USER": "u", "DB_NAME": "d"}, "host"},
		{"discrete missing user", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_NAME": "d"}, "user"},
		{"pg missing database", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u"}, "database"},
		{"oracle no db no sid", map[string]string{"DB_DRIVER": "oracle", "DB_HOST": "h", "DB_USER": "u"}, "oracle"},
		{"oracle both db and sid", map[string]string{"DB_DRIVER": "oracle", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "svc", "DB_ORACLE_SID": "X"}, "one of"},
		{"dsn plus password", map[string]string{"DB_DRIVER": "postgres", "DB_DSN": "postgres://u:p@h/d", "DB_PASSWORD": "p"}, "db_password"},
		{"dsn plus dsn_cmd", map[string]string{"DB_DRIVER": "postgres", "DB_DSN": "postgres://u:p@h/d", "DB_DSN_CMD": "echo x"}, "mutually exclusive"},
		{"password plus password_cmd", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d", "DB_PASSWORD": "p", "DB_PASSWORD_CMD": "c"}, "mutually exclusive"},
		{"bad port", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d", "DB_PORT": "nan"}, "db_port"},
		{"bad max_rows", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d", "DB_MAX_ROWS": "-2"}, "db_max_rows"},
		{"bad permissions", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d", "DB_PERMISSIONS": "read,admin"}, "permission"},
		{"bad timeout", map[string]string{"DB_DRIVER": "postgres", "DB_HOST": "h", "DB_USER": "u", "DB_NAME": "d", "DB_QUERY_TIMEOUT": "nope"}, "query_timeout"},
		{"bad allow_unfiltered_writes", map[string]string{"DB_DRIVER": "postgres", "DB_DSN": "postgres://u:p@h/d", "DB_ALLOW_UNFILTERED_WRITES": "maybe"}, "db_allow_unfiltered_writes"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			clearDBEnv(t)
			for k, v := range c.env {
				t.Setenv(k, v)
			}
			_, err := LoadConfig()
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !strings.Contains(strings.ToLower(err.Error()), c.wantErr) {
				t.Errorf("error %q does not mention %q", err, c.wantErr)
			}
		})
	}
}

func TestBuildDSN(t *testing.T) {
	pg, err := buildDSN("pgx", "h", 5432, "u", "p", "d", "")
	if err != nil || pg != "postgres://u:p@h:5432/d" {
		t.Errorf("pg DSN = %q, %v", pg, err)
	}
	ms, err := buildDSN("sqlserver", "h", 1433, "u", "p", "d", "")
	if err != nil || !strings.Contains(ms, "sqlserver://u:p@h:1433?database=d") {
		t.Errorf("mssql DSN = %q, %v", ms, err)
	}
	ora, err := buildDSN("oracle", "h", 1521, "u", "p", "svc", "")
	if err != nil || !strings.HasPrefix(ora, "oracle://") {
		t.Errorf("oracle DSN = %q, %v", ora, err)
	}
}

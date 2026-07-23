package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func clearDBEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"DB_DRIVER", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD",
		"DB_NAME", "DB_ORACLE_SID", "DB_PERMISSIONS", "DB_MAX_ROWS", "DB_QUERY_TIMEOUT"} {
		t.Setenv(k, "")
	}
}

func TestParseFileConfigValid(t *testing.T) {
	data := []byte(`{
		"connections": [
			{
				"name": "pg-prod",
				"description": "prod postgres",
				"driver": "postgres",
				"host": "db.internal",
				"user": "app_ro",
				"password": "secret",
				"database": "appdb",
				"permissions": "read",
				"query_timeout": "5s",
				"max_cell_bytes": 100
			},
			{
				"name": "ora-dev",
				"driver": "oracle",
				"host": "ora-host",
				"port": 1522,
				"user": "scott",
				"password_cmd": "security find-generic-password -s ora-dev -w",
				"oracle_sid": "ORCL",
				"permissions": "read,create,update,delete",
				"allow_unfiltered_writes": true
			}
		],
		"audit_path": "/tmp/audit.jsonl"
	}`)

	fc, err := parseFileConfig(data)
	if err != nil {
		t.Fatalf("parseFileConfig: %v", err)
	}
	if fc.AuditPath != "/tmp/audit.jsonl" {
		t.Errorf("AuditPath = %q, want /tmp/audit.jsonl", fc.AuditPath)
	}
	if len(fc.Connections) != 2 {
		t.Fatalf("got %d connections, want 2", len(fc.Connections))
	}

	pg := fc.Connections[0]
	if pg.SQLDriver != "pgx" || pg.DisplayName != "postgres" {
		t.Errorf("pg driver resolved to (%q, %q), want (pgx, postgres)", pg.SQLDriver, pg.DisplayName)
	}
	if pg.Port != 5432 {
		t.Errorf("pg.Port = %d, want default 5432", pg.Port)
	}
	if pg.MaxRows != 500 {
		t.Errorf("pg.MaxRows = %d, want default 500", pg.MaxRows)
	}
	if pg.Timeout != 5*time.Second {
		t.Errorf("pg.Timeout = %v, want 5s", pg.Timeout)
	}
	if !pg.Perms[OpRead] || pg.Perms[OpDelete] {
		t.Errorf("pg.Perms = %v, want read only", pg.Perms)
	}
	if pg.MaxCellBytes != 100 {
		t.Errorf("pg.MaxCellBytes = %d, want 100 (explicit)", pg.MaxCellBytes)
	}

	ora := fc.Connections[1]
	if ora.SQLDriver != "oracle" {
		t.Errorf("ora.SQLDriver = %q, want oracle", ora.SQLDriver)
	}
	if ora.Port != 1522 {
		t.Errorf("ora.Port = %d, want explicit 1522", ora.Port)
	}
	if ora.Timeout != 30*time.Second {
		t.Errorf("ora.Timeout = %v, want default 30s", ora.Timeout)
	}
	if !ora.Perms[OpRead] || !ora.Perms[OpCreate] || !ora.Perms[OpUpdate] || !ora.Perms[OpDelete] {
		t.Errorf("ora.Perms = %v, want full crud", ora.Perms)
	}
	if ora.PasswordCmd == "" {
		t.Error("ora.PasswordCmd lost in parsing")
	}
	if !ora.AllowUnfilteredWrites {
		t.Error("ora.AllowUnfilteredWrites = false, want true")
	}
	if ora.MaxCellBytes != 8192 {
		t.Errorf("ora.MaxCellBytes = %d, want default 8192", ora.MaxCellBytes)
	}
}

func TestParseFileConfigDriverAliases(t *testing.T) {
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
		db, sid := `"database": "d"`, ``
		if c.alias == "oracle" {
			db, sid = ``, `"oracle_sid": "X",`
		}
		j := `{"connections":[{"name":"c1","driver":"` + c.alias + `","host":"h","user":"u",` + sid + db
		j = strings.TrimRight(j, ",") + `}]}`
		fc, err := parseFileConfig([]byte(j))
		if err != nil {
			t.Errorf("%s: %v", c.alias, err)
			continue
		}
		got := fc.Connections[0]
		if got.SQLDriver != c.sqlDriver || got.Port != c.defPort {
			t.Errorf("%s resolved to (%s, %d), want (%s, %d)", c.alias, got.SQLDriver, got.Port, c.sqlDriver, c.defPort)
		}
	}
}

func TestLoadConfigFileWinsOverEnv(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres") // legacy env present but must lose to the file
	t.Setenv("DB_HOST", "envhost")
	t.Setenv("DB_USER", "envuser")
	t.Setenv("DB_NAME", "envdb")

	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"connections":[
		{"name":"filecon","driver":"sqlserver","host":"h","user":"u","database":"d"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fc, err := loadConfig(path, "")
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if len(fc.Connections) != 1 || fc.Connections[0].Name != "filecon" {
		t.Errorf("expected file connection to win, got %+v", fc.Connections)
	}
}

func TestLoadConfigExplicitPathMissing(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres") // even with legacy env, an explicit path must not silently fall back
	_, err := loadConfig(filepath.Join(t.TempDir(), "nope.json"), "")
	if err == nil || !strings.Contains(err.Error(), "nope.json") {
		t.Errorf("expected read error naming the file, got %v", err)
	}
}

func TestLoadConfigLegacyEnvFallback(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DB_HOST", "envhost")
	t.Setenv("DB_USER", "envuser")
	t.Setenv("DB_PASSWORD", "trailing space ") // passwords are never trimmed
	t.Setenv("DB_NAME", "envdb")
	t.Setenv("DB_PERMISSIONS", "read,create")
	t.Setenv("DB_MAX_ROWS", "42")

	fc, err := loadConfig("", filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if len(fc.Connections) != 1 {
		t.Fatalf("got %d connections, want 1", len(fc.Connections))
	}
	c := fc.Connections[0]
	if c.Name != "default" {
		t.Errorf("legacy connection name = %q, want default", c.Name)
	}
	if c.SQLDriver != "pgx" || c.Host != "envhost" || c.Port != 5432 {
		t.Errorf("legacy resolve got (%s, %s, %d)", c.SQLDriver, c.Host, c.Port)
	}
	if c.Password != "trailing space " {
		t.Errorf("password was trimmed: %q", c.Password)
	}
	if !c.Perms[OpRead] || !c.Perms[OpCreate] || c.Perms[OpDelete] {
		t.Errorf("legacy perms = %v", c.Perms)
	}
	if c.MaxRows != 42 {
		t.Errorf("legacy MaxRows = %d, want 42", c.MaxRows)
	}
}

func TestLoadConfigLegacyBadPort(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("DB_DRIVER", "oracle")
	t.Setenv("DB_HOST", "h")
	t.Setenv("DB_USER", "u")
	t.Setenv("DB_ORACLE_SID", "X")
	t.Setenv("DB_PORT", "nan")
	_, err := loadConfig("", filepath.Join(t.TempDir(), "absent.json"))
	if err == nil || !strings.Contains(err.Error(), "DB_PORT") {
		t.Errorf("expected DB_PORT error, got %v", err)
	}
}

func TestLoadConfigNothingConfigured(t *testing.T) {
	clearDBEnv(t)
	_, err := loadConfig("", filepath.Join(t.TempDir(), "absent.json"))
	if err == nil || !strings.Contains(err.Error(), "DB_MCP_CONFIG") {
		t.Errorf("expected guidance naming DB_MCP_CONFIG, got %v", err)
	}
}

func TestParseFileConfigErrors(t *testing.T) {
	cases := []struct {
		label   string
		json    string
		wantErr string
	}{
		{"invalid json", `{`, "parse"},
		{"no connections", `{"connections":[]}`, "at least one connection"},
		{"missing name", `{"connections":[{"driver":"postgres","host":"h","user":"u","database":"d"}]}`, "name"},
		{"dup names", `{"connections":[
			{"name":"a","driver":"postgres","host":"h","user":"u","database":"d"},
			{"name":"a","driver":"postgres","host":"h","user":"u","database":"d"}]}`, "duplicate"},
		{"bad driver", `{"connections":[{"name":"a","driver":"mysql","host":"h","user":"u","database":"d"}]}`, "driver"},
		{"missing host", `{"connections":[{"name":"a","driver":"postgres","user":"u","database":"d"}]}`, "host"},
		{"missing user", `{"connections":[{"name":"a","driver":"postgres","host":"h","database":"d"}]}`, "user"},
		{"pg missing database", `{"connections":[{"name":"a","driver":"postgres","host":"h","user":"u"}]}`, "database"},
		{"oracle no db no sid", `{"connections":[{"name":"a","driver":"oracle","host":"h","user":"u"}]}`, "oracle"},
		{"oracle both db and sid", `{"connections":[{"name":"a","driver":"oracle","host":"h","user":"u","database":"d","oracle_sid":"s"}]}`, "one of"},
		{"password and password_cmd", `{"connections":[{"name":"a","driver":"postgres","host":"h","user":"u","database":"d","password":"p","password_cmd":"c"}]}`, "password_cmd"},
		{"bad timeout", `{"connections":[{"name":"a","driver":"postgres","host":"h","user":"u","database":"d","query_timeout":"nope"}]}`, "query_timeout"},
		{"negative max_rows", `{"connections":[{"name":"a","driver":"postgres","host":"h","user":"u","database":"d","max_rows":-2}]}`, "max_rows"},
		{"bad permissions", `{"connections":[{"name":"a","driver":"postgres","host":"h","user":"u","database":"d","permissions":"read,admin"}]}`, "permission"},
	}
	for _, c := range cases {
		_, err := parseFileConfig([]byte(c.json))
		if err == nil {
			t.Errorf("%s: expected error, got nil", c.label)
			continue
		}
		if !strings.Contains(strings.ToLower(err.Error()), c.wantErr) {
			t.Errorf("%s: error %q does not mention %q", c.label, err, c.wantErr)
		}
	}
}

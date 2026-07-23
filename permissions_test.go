package main

import (
	"strings"
	"testing"
)

func TestParsePerms(t *testing.T) {
	cases := []struct {
		in      string
		want    []Op
		wantErr bool
	}{
		{"", []Op{OpRead}, false},
		{"  ", []Op{OpRead}, false},
		{"read", []Op{OpRead}, false},
		{"read,create,update,delete", []Op{OpRead, OpCreate, OpUpdate, OpDelete}, false},
		{" READ , Create ", []Op{OpRead, OpCreate}, false},
		{"read,write", nil, true},
		{"drop", nil, true},
	}
	for _, c := range cases {
		ps, err := ParsePerms(c.in)
		if (err != nil) != c.wantErr {
			t.Errorf("ParsePerms(%q) err=%v wantErr=%v", c.in, err, c.wantErr)
			continue
		}
		if c.wantErr {
			continue
		}
		for _, op := range c.want {
			if !ps[op] {
				t.Errorf("ParsePerms(%q) missing %q", c.in, op)
			}
		}
		if len(ps) != len(c.want) {
			t.Errorf("ParsePerms(%q) = %v, want exactly %v", c.in, ps, c.want)
		}
	}
}

func TestAuthorize(t *testing.T) {
	all := PermSet{OpRead: true, OpCreate: true, OpUpdate: true, OpDelete: true}
	ro := PermSet{OpRead: true}
	rd := PermSet{OpRead: true, OpDelete: true}

	cases := []struct {
		name    string
		sql     string
		perms   PermSet
		wantErr bool
	}{
		{"select read-only ok", "SELECT * FROM users", ro, false},
		{"lowercase select ok", "select id from t", ro, false},
		{"select denied without read", "SELECT 1", PermSet{OpCreate: true}, true},
		{"insert denied read-only", "INSERT INTO t VALUES (1)", ro, true},
		{"insert ok with create", "INSERT INTO t (a) VALUES (1)", all, false},
		{"update ok", "UPDATE t SET x = 1 WHERE id = 2", all, false},
		{"update denied read-only", "UPDATE t SET x = 1", ro, true},
		{"delete denied read-only", "DELETE FROM t WHERE id = 1", ro, true},
		{"delete ok with delete", "DELETE FROM t WHERE id = 1", rd, false},

		{"drop denied always", "DROP TABLE t", all, true},
		{"create denied always", "CREATE TABLE t (id int)", all, true},
		{"alter denied always", "ALTER TABLE t ADD c int", all, true},
		{"truncate denied always", "TRUNCATE TABLE t", all, true},
		{"merge denied always", "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.a=s.a", all, true},
		{"exec denied always", "EXEC sp_who", all, true},
		{"call denied always", "CALL my_proc()", all, true},
		{"grant denied always", "GRANT SELECT ON t TO u", all, true},

		{"multi-statement rejected", "SELECT 1; DROP TABLE t", all, true},
		{"trailing semicolon ok", "SELECT 1;", ro, false},
		{"semicolon in string is not a 2nd stmt", "SELECT ';' AS x", ro, false},
		{"semicolon in comment is not a 2nd stmt", "SELECT 1 /* ; DROP TABLE t ; */", ro, false},
		{"line comment then live stmt rejected", "SELECT 1 -- note\n; DROP TABLE t", all, true},

		{"select into denied", "SELECT * INTO new_t FROM t", all, true},
		{"updated_at is not UPDATE", "SELECT updated_at FROM t", ro, false},
		{"column named into in string ok", "SELECT 'into' AS k FROM t", ro, false},

		{"read-only CTE ok", "WITH c AS (SELECT 1 AS n) SELECT * FROM c", ro, false},
		{"write CTE gated by inner verb", "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)", ro, true},
		{"write CTE ok when delete allowed", "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)", rd, false},
		{"insert-into CTE not mistaken for SELECT INTO", "WITH c AS (SELECT 1 AS n) INSERT INTO t (n) SELECT n FROM c", all, false},

		{"empty rejected", "   ", all, true},
		{"leading paren select ok", "(SELECT 1)", ro, false},
		{"block comment lead ok", "/* hi */ SELECT 1", ro, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &ConnConfig{SQLDriver: "pgx", Perms: c.perms}
			_, err := Authorize(c.sql, cfg)
			if (err != nil) != c.wantErr {
				t.Errorf("Authorize(%q) err=%v, wantErr=%v", c.sql, err, c.wantErr)
			}
		})
	}
}

// TestClassifierV2 covers the token-scanner WITH handling, the WHERE guard
// and postgres dollar-quoting.
func TestClassifierV2(t *testing.T) {
	all := PermSet{OpRead: true, OpCreate: true, OpUpdate: true, OpDelete: true}
	ro := PermSet{OpRead: true}
	rd := PermSet{OpRead: true, OpDelete: true}

	cases := []struct {
		name            string
		sql             string
		driver          string // defaults to pgx
		perms           PermSet
		allowUnfiltered bool
		wantErr         bool
	}{
		// false positives fixed by verb-position scanning
		{"FOR UPDATE inside CTE is a read", "WITH c AS (SELECT id FROM t FOR UPDATE) SELECT * FROM c", "", ro, false, false},
		{"write verbs as column names are a read", "WITH c AS (SELECT update, insert, delete FROM audit_log) SELECT * FROM c", "", ro, false, false},
		{"top-level FOR UPDATE stays a read", "SELECT id FROM t FOR UPDATE", "", ro, false, false},

		// must-not-break: pg data-modifying CTEs are still writes
		{"data-modifying CTE still needs delete", "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x", "", ro, false, true},
		{"data-modifying CTE ok with delete", "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x", "", rd, false, false},

		// structural WITH forms
		{"NOT MATERIALIZED CTE", "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x", "", ro, false, false},
		{"MATERIALIZED CTE", "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x", "", ro, false, false},
		{"nested WITH", "WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a", "", ro, false, false},
		{"CTE column list", "WITH c(a, b) AS (SELECT 1, 2) SELECT * FROM c", "", ro, false, false},

		// security: non-CRUD main verbs after a CTE are denied (old code let
		// these through as reads)
		{"CALL after CTE denied", "WITH x AS (SELECT 1) CALL p()", "", all, false, true},
		{"EXEC after CTE denied", "WITH x AS (SELECT 1) EXEC sp_who", "", all, false, true},

		// WHERE guard
		{"unfiltered DELETE denied", "DELETE FROM t", "", rd, false, true},
		{"unfiltered DELETE allowed with flag", "DELETE FROM t", "", rd, true, false},
		{"unfiltered UPDATE denied", "UPDATE t SET x = 1", "", all, false, true},
		{"WHERE only in subquery still unfiltered", "UPDATE t SET x = (SELECT y FROM u WHERE u.id = 1)", "", all, false, true},
		{"DELETE with WHERE subquery ok", "DELETE FROM t WHERE id IN (SELECT id FROM s)", "", rd, false, false},
		{"unfiltered write inside CTE denied", "WITH x AS (DELETE FROM t) SELECT 1", "", rd, false, true},
		{"unfiltered write inside CTE allowed with flag", "WITH x AS (DELETE FROM t) SELECT 1", "", rd, true, false},

		// postgres dollar-quoting
		{"semicolon in dollar quote is not a 2nd stmt", "SELECT $$; DROP TABLE t$$", "", ro, false, false},
		{"same input on sqlserver keeps old behavior", "SELECT $$; DROP TABLE t$$", "sqlserver", ro, false, true},
		{"write verb in tagged dollar quote is a read", "WITH c AS (SELECT $tag$DELETE$tag$ AS x) SELECT * FROM c", "", ro, false, false},
		{"apostrophe in dollar quote does not desync", "SELECT $$it's; fine$$ AS x", "", ro, false, false},
		{"positional param unaffected", "SELECT $1", "", ro, false, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			driver := c.driver
			if driver == "" {
				driver = "pgx"
			}
			cfg := &ConnConfig{SQLDriver: driver, Perms: c.perms, AllowUnfilteredWrites: c.allowUnfiltered}
			_, err := Authorize(c.sql, cfg)
			if (err != nil) != c.wantErr {
				t.Errorf("Authorize(%q) err=%v, wantErr=%v", c.sql, err, c.wantErr)
			}
		})
	}
}

func TestWhereGuardMessage(t *testing.T) {
	rd := PermSet{OpRead: true, OpDelete: true}
	_, err := Authorize("DELETE FROM t", &ConnConfig{SQLDriver: "pgx", Perms: rd})
	if err == nil || !strings.Contains(err.Error(), "allow_unfiltered_writes") {
		t.Errorf("guard error should mention the override flag, got: %v", err)
	}
}

func TestReturnsRows(t *testing.T) {
	cases := []struct {
		sql  string
		want bool
	}{
		{"SELECT 1", true},
		{"WITH c AS (SELECT 1) SELECT * FROM c", true},
		{"INSERT INTO t VALUES (1)", false},
		{"UPDATE t SET x = 1", false},
		{"DELETE FROM t", false},
		{"INSERT INTO t (a) VALUES (1) RETURNING id", true},
		{"UPDATE t SET x = 1 OUTPUT inserted.id", true},
	}
	for _, c := range cases {
		if got := ReturnsRows(c.sql, "pgx"); got != c.want {
			t.Errorf("ReturnsRows(%q) = %v, want %v", c.sql, got, c.want)
		}
	}
}

package main

import (
	"reflect"
	"testing"
)

func TestParseKeychainConns(t *testing.T) {
	dump := `
keychain: "/Users/x/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
    "acct"<blob>="navy-dev"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/ah-product"
    "acct"<blob>="ah-product"
class: "genp"
attributes:
    "svce"<blob>="some-other-service"
    "acct"<blob>="me"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
`
	got := parseKeychainConns(dump)
	want := []string{"ah-product", "navy-dev"} // sorted, deduped, non-db-mcp excluded
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseKeychainConns = %v, want %v", got, want)
	}
}

func TestValidConnName(t *testing.T) {
	ok := []string{"navy-dev", "ah_product", "db.one", "A1"}
	bad := []string{"", "has space", "with/slash", "a;b", "quote\""}
	for _, s := range ok {
		if !validConnName(s) {
			t.Errorf("validConnName(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if validConnName(s) {
			t.Errorf("validConnName(%q) = true, want false", s)
		}
	}
}

func TestResolveDriver(t *testing.T) {
	cases := map[string]struct {
		sqlDriver string
		port      int
	}{
		"postgres":   {"pgx", 5432},
		"postgresql": {"pgx", 5432},
		"sqlserver":  {"sqlserver", 1433},
		"mssql":      {"sqlserver", 1433},
		"oracle":     {"oracle", 1521},
	}
	for in, want := range cases {
		sd, _, port, ok := resolveDriver(in)
		if !ok || sd != want.sqlDriver || port != want.port {
			t.Errorf("resolveDriver(%q) = (%q, %d, %v), want (%q, %d, true)", in, sd, port, ok, want.sqlDriver, want.port)
		}
	}
	if _, _, _, ok := resolveDriver("mysql"); ok {
		t.Error("resolveDriver(mysql) ok = true, want false")
	}
}

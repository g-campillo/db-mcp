import { describe, expect, it } from "vitest";
import type { SqlDriver } from "./drivers.js";
import {
  authorize,
  parsePerms,
  permsToString,
  returnsRows,
  type AuthConfig,
  type Op,
  type PermSet,
} from "./permissions.js";

const all: PermSet = new Set<Op>(["read", "create", "update", "delete"]);
const ro: PermSet = new Set<Op>(["read"]);
const rd: PermSet = new Set<Op>(["read", "delete"]);

function cfg(
  perms: PermSet,
  opts: { driver?: SqlDriver; allowUnfiltered?: boolean } = {},
): AuthConfig {
  return {
    sqlDriver: opts.driver ?? "pgx",
    perms,
    allowUnfilteredWrites: opts.allowUnfiltered ?? false,
  };
}

describe("parsePerms", () => {
  it.each<[string, Op[]]>([
    ["", ["read"]],
    ["  ", ["read"]],
    ["read", ["read"]],
    ["read,create,update,delete", ["read", "create", "update", "delete"]],
    [" READ , Create ", ["read", "create"]],
  ])("parses %j", (input, want) => {
    const ps = parsePerms(input);
    expect([...ps].sort()).toEqual([...want].sort());
  });

  it.each(["read,write", "drop"])("rejects %j", (input) => {
    expect(() => parsePerms(input)).toThrow(/unknown permission/);
  });

  it("renders permitted ops in canonical order", () => {
    expect(permsToString(parsePerms("delete,read"))).toBe("read, delete");
  });
});

describe("authorize", () => {
  const cases: Array<[name: string, sql: string, perms: PermSet, wantErr: boolean]> = [
    ["select read-only ok", "SELECT * FROM users", ro, false],
    ["lowercase select ok", "select id from t", ro, false],
    ["select denied without read", "SELECT 1", new Set<Op>(["create"]), true],
    ["insert denied read-only", "INSERT INTO t VALUES (1)", ro, true],
    ["insert ok with create", "INSERT INTO t (a) VALUES (1)", all, false],
    ["update ok", "UPDATE t SET x = 1 WHERE id = 2", all, false],
    ["update denied read-only", "UPDATE t SET x = 1", ro, true],
    ["delete denied read-only", "DELETE FROM t WHERE id = 1", ro, true],
    ["delete ok with delete", "DELETE FROM t WHERE id = 1", rd, false],

    ["drop denied always", "DROP TABLE t", all, true],
    ["create denied always", "CREATE TABLE t (id int)", all, true],
    ["alter denied always", "ALTER TABLE t ADD c int", all, true],
    ["truncate denied always", "TRUNCATE TABLE t", all, true],
    [
      "merge denied always",
      "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.a=s.a",
      all,
      true,
    ],
    ["exec denied always", "EXEC sp_who", all, true],
    ["call denied always", "CALL my_proc()", all, true],
    ["grant denied always", "GRANT SELECT ON t TO u", all, true],

    ["multi-statement rejected", "SELECT 1; DROP TABLE t", all, true],
    ["trailing semicolon ok", "SELECT 1;", ro, false],
    ["semicolon in string is not a 2nd stmt", "SELECT ';' AS x", ro, false],
    ["semicolon in comment is not a 2nd stmt", "SELECT 1 /* ; DROP TABLE t ; */", ro, false],
    ["line comment then live stmt rejected", "SELECT 1 -- note\n; DROP TABLE t", all, true],

    ["select into denied", "SELECT * INTO new_t FROM t", all, true],
    ["updated_at is not UPDATE", "SELECT updated_at FROM t", ro, false],
    ["column named into in string ok", "SELECT 'into' AS k FROM t", ro, false],

    ["read-only CTE ok", "WITH c AS (SELECT 1 AS n) SELECT * FROM c", ro, false],
    [
      "write CTE gated by inner verb",
      "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)",
      ro,
      true,
    ],
    [
      "write CTE ok when delete allowed",
      "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)",
      rd,
      false,
    ],
    [
      "insert-into CTE not mistaken for SELECT INTO",
      "WITH c AS (SELECT 1 AS n) INSERT INTO t (n) SELECT n FROM c",
      all,
      false,
    ],

    ["empty rejected", "   ", all, true],
    ["leading paren select ok", "(SELECT 1)", ro, false],
    ["block comment lead ok", "/* hi */ SELECT 1", ro, false],
  ];

  it.each(cases)("%s", (_name, sql, perms, wantErr) => {
    const run = () => authorize(sql, cfg(perms));
    if (wantErr) expect(run).toThrow();
    else expect(run).not.toThrow();
  });
});

// Covers the token-scanner WITH handling, the WHERE guard and postgres
// dollar-quoting.
describe("classifier v2", () => {
  const cases: Array<
    [
      name: string,
      sql: string,
      driver: SqlDriver,
      perms: PermSet,
      allowUnfiltered: boolean,
      wantErr: boolean,
    ]
  > = [
    // false positives fixed by verb-position scanning
    [
      "FOR UPDATE inside CTE is a read",
      "WITH c AS (SELECT id FROM t FOR UPDATE) SELECT * FROM c",
      "pgx",
      ro,
      false,
      false,
    ],
    [
      "write verbs as column names are a read",
      "WITH c AS (SELECT update, insert, delete FROM audit_log) SELECT * FROM c",
      "pgx",
      ro,
      false,
      false,
    ],
    ["top-level FOR UPDATE stays a read", "SELECT id FROM t FOR UPDATE", "pgx", ro, false, false],

    // must-not-break: pg data-modifying CTEs are still writes
    [
      "data-modifying CTE still needs delete",
      "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x",
      "pgx",
      ro,
      false,
      true,
    ],
    [
      "data-modifying CTE ok with delete",
      "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x",
      "pgx",
      rd,
      false,
      false,
    ],

    // structural WITH forms
    [
      "NOT MATERIALIZED CTE",
      "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x",
      "pgx",
      ro,
      false,
      false,
    ],
    [
      "MATERIALIZED CTE",
      "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x",
      "pgx",
      ro,
      false,
      false,
    ],
    [
      "nested WITH",
      "WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a",
      "pgx",
      ro,
      false,
      false,
    ],
    ["CTE column list", "WITH c(a, b) AS (SELECT 1, 2) SELECT * FROM c", "pgx", ro, false, false],

    // security: non-CRUD main verbs after a CTE are denied
    ["CALL after CTE denied", "WITH x AS (SELECT 1) CALL p()", "pgx", all, false, true],
    ["EXEC after CTE denied", "WITH x AS (SELECT 1) EXEC sp_who", "pgx", all, false, true],

    // WHERE guard
    ["unfiltered DELETE denied", "DELETE FROM t", "pgx", rd, false, true],
    ["unfiltered DELETE allowed with flag", "DELETE FROM t", "pgx", rd, true, false],
    ["unfiltered UPDATE denied", "UPDATE t SET x = 1", "pgx", all, false, true],
    [
      "WHERE only in subquery still unfiltered",
      "UPDATE t SET x = (SELECT y FROM u WHERE u.id = 1)",
      "pgx",
      all,
      false,
      true,
    ],
    [
      "DELETE with WHERE subquery ok",
      "DELETE FROM t WHERE id IN (SELECT id FROM s)",
      "pgx",
      rd,
      false,
      false,
    ],
    [
      "unfiltered write inside CTE denied",
      "WITH x AS (DELETE FROM t) SELECT 1",
      "pgx",
      rd,
      false,
      true,
    ],
    [
      "unfiltered write inside CTE allowed with flag",
      "WITH x AS (DELETE FROM t) SELECT 1",
      "pgx",
      rd,
      true,
      false,
    ],

    // postgres dollar-quoting
    [
      "semicolon in dollar quote is not a 2nd stmt",
      "SELECT $$; DROP TABLE t$$",
      "pgx",
      ro,
      false,
      false,
    ],
    [
      "same input on sqlserver keeps old behavior",
      "SELECT $$; DROP TABLE t$$",
      "sqlserver",
      ro,
      false,
      true,
    ],
    [
      "write verb in tagged dollar quote is a read",
      "WITH c AS (SELECT $tag$DELETE$tag$ AS x) SELECT * FROM c",
      "pgx",
      ro,
      false,
      false,
    ],
    [
      "apostrophe in dollar quote does not desync",
      "SELECT $$it's; fine$$ AS x",
      "pgx",
      ro,
      false,
      false,
    ],
    ["positional param unaffected", "SELECT $1", "pgx", ro, false, false],
  ];

  it.each(cases)("%s", (_name, sql, driver, perms, allowUnfiltered, wantErr) => {
    const run = () => authorize(sql, cfg(perms, { driver, allowUnfiltered }));
    if (wantErr) expect(run).toThrow();
    else expect(run).not.toThrow();
  });
});

describe("authorize return value", () => {
  it("reports both ops for a data-modifying CTE", () => {
    const ops = authorize(
      "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x",
      cfg(rd),
    );
    expect(new Set(ops)).toEqual(new Set<Op>(["delete", "read"]));
  });

  it("dedupes repeated ops", () => {
    const ops = authorize("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a", cfg(ro));
    expect(ops).toEqual(["read"]);
  });
});

it("where-guard error mentions the override flag", () => {
  expect(() => authorize("DELETE FROM t", cfg(rd))).toThrow(/allow_unfiltered_writes/);
});

describe("returnsRows", () => {
  it.each<[string, boolean]>([
    ["SELECT 1", true],
    ["WITH c AS (SELECT 1) SELECT * FROM c", true],
    ["INSERT INTO t VALUES (1)", false],
    ["UPDATE t SET x = 1", false],
    ["DELETE FROM t", false],
    ["INSERT INTO t (a) VALUES (1) RETURNING id", true],
    ["UPDATE t SET x = 1 OUTPUT inserted.id", true],
  ])("%s -> %s", (sql, want) => {
    expect(returnsRows(sql, "pgx")).toBe(want);
  });
});

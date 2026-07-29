import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { resolveDriver, type SqlDriver } from "./drivers.js";

/** Only the given DB_* vars are visible, so ambient environment can't leak in. */
function env(vars: Record<string, string>): Record<string, string | undefined> {
  return vars;
}

describe("loadConfig", () => {
  it("resolves discrete-field mode", () => {
    const c = loadConfig(
      env({
        DB_DRIVER: "postgres",
        DB_HOST: "envhost",
        DB_USER: "envuser",
        DB_PASSWORD: "trailing space ", // passwords are never trimmed
        DB_NAME: "envdb",
        DB_PERMISSIONS: "read,create",
        DB_MAX_ROWS: "42",
      }),
    );
    expect(c.name).toBe("default");
    expect(c.sqlDriver).toBe("pgx");
    expect(c.displayName).toBe("postgres");
    expect(c.host).toBe("envhost");
    expect(c.port).toBe(5432);
    expect(c.password).toBe("trailing space ");
    expect([...c.perms].sort()).toEqual(["create", "read"]);
    expect(c.maxRows).toBe(42);
    expect(c.timeoutMs).toBe(30_000);
    expect(c.maxCellBytes).toBe(8192);
  });

  it("defaults to read-only with a 500-row cap", () => {
    const c = loadConfig(
      env({ DB_DRIVER: "postgres", DB_HOST: "h", DB_USER: "u", DB_NAME: "d" }),
    );
    expect([...c.perms]).toEqual(["read"]);
    expect(c.maxRows).toBe(500);
    expect(c.allowUnfilteredWrites).toBe(false);
  });

  it.each<[string, SqlDriver, number]>([
    ["postgres", "pgx", 5432],
    ["postgresql", "pgx", 5432],
    ["sqlserver", "sqlserver", 1433],
    ["mssql", "sqlserver", 1433],
    ["oracle", "oracle", 1521],
  ])("accepts driver alias %s", (alias, sqlDriver, defPort) => {
    const extra: Record<string, string> =
      alias === "oracle" ? { DB_ORACLE_SID: "X" } : { DB_NAME: "d" };
    const c = loadConfig(env({ DB_DRIVER: alias, DB_HOST: "h", DB_USER: "u", ...extra }));
    expect(c.sqlDriver).toBe(sqlDriver);
    expect(c.port).toBe(defPort);
  });

  it("accepts DSN mode without discrete fields", () => {
    const c = loadConfig(
      env({
        DB_DRIVER: "postgres",
        DB_DSN: "postgres://u:p@h:5432/d",
        DB_PERMISSIONS: "read",
      }),
    );
    expect(c.dsn).toBe("postgres://u:p@h:5432/d");
    expect(c.sqlDriver).toBe("pgx");
    expect(c.host).toBe("");
  });

  it("keeps DB_DSN_CMD unresolved at load time", () => {
    const c = loadConfig(
      env({
        DB_DRIVER: "oracle",
        // The command is NOT run at config-load time, so an arbitrary command
        // still resolves the config cleanly.
        DB_DSN_CMD: "security find-generic-password -s db-mcp/ora -w",
        DB_PERMISSIONS: "read,create,update,delete",
      }),
    );
    expect(c.dsnCmd).not.toBe("");
    expect(c.perms.has("delete")).toBe(true);
  });

  it("parses DB_ALLOW_UNFILTERED_WRITES", () => {
    const c = loadConfig(
      env({
        DB_DRIVER: "postgres",
        DB_DSN: "postgres://u:p@h:5432/d",
        DB_ALLOW_UNFILTERED_WRITES: "true",
      }),
    );
    expect(c.allowUnfilteredWrites).toBe(true);
  });

  it.each<[string, string]>([
    ["30s", "30000"],
    ["1m30s", "90000"],
    ["500ms", "500"],
  ])("parses the Go duration %s in DB_QUERY_TIMEOUT", (text, wantMs) => {
    const c = loadConfig(
      env({ DB_DRIVER: "postgres", DB_DSN: "postgres://u:p@h/d", DB_QUERY_TIMEOUT: text }),
    );
    expect(c.timeoutMs).toBe(Number(wantMs));
  });
});

describe("loadConfig errors", () => {
  const cases: Array<[label: string, vars: Record<string, string>, wantErr: string]> = [
    ["missing driver", {}, "db_driver"],
    [
      "bad driver",
      { DB_DRIVER: "mysql", DB_HOST: "h", DB_USER: "u", DB_NAME: "d" },
      "driver",
    ],
    ["discrete missing host", { DB_DRIVER: "postgres", DB_USER: "u", DB_NAME: "d" }, "host"],
    ["discrete missing user", { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d" }, "user"],
    ["pg missing database", { DB_DRIVER: "postgres", DB_HOST: "h", DB_USER: "u" }, "database"],
    ["oracle no db no sid", { DB_DRIVER: "oracle", DB_HOST: "h", DB_USER: "u" }, "oracle"],
    [
      "oracle both db and sid",
      { DB_DRIVER: "oracle", DB_HOST: "h", DB_USER: "u", DB_NAME: "svc", DB_ORACLE_SID: "X" },
      "one of",
    ],
    [
      "dsn plus password",
      { DB_DRIVER: "postgres", DB_DSN: "postgres://u:p@h/d", DB_PASSWORD: "p" },
      "db_password",
    ],
    [
      "dsn plus dsn_cmd",
      { DB_DRIVER: "postgres", DB_DSN: "postgres://u:p@h/d", DB_DSN_CMD: "echo x" },
      "mutually exclusive",
    ],
    [
      "password plus password_cmd",
      {
        DB_DRIVER: "postgres",
        DB_HOST: "h",
        DB_USER: "u",
        DB_NAME: "d",
        DB_PASSWORD: "p",
        DB_PASSWORD_CMD: "c",
      },
      "mutually exclusive",
    ],
    [
      "bad port",
      { DB_DRIVER: "postgres", DB_HOST: "h", DB_USER: "u", DB_NAME: "d", DB_PORT: "nan" },
      "db_port",
    ],
    [
      "bad max_rows",
      { DB_DRIVER: "postgres", DB_HOST: "h", DB_USER: "u", DB_NAME: "d", DB_MAX_ROWS: "-2" },
      "db_max_rows",
    ],
    [
      "bad permissions",
      {
        DB_DRIVER: "postgres",
        DB_HOST: "h",
        DB_USER: "u",
        DB_NAME: "d",
        DB_PERMISSIONS: "read,admin",
      },
      "permission",
    ],
    [
      "bad timeout",
      {
        DB_DRIVER: "postgres",
        DB_HOST: "h",
        DB_USER: "u",
        DB_NAME: "d",
        DB_QUERY_TIMEOUT: "nope",
      },
      "query_timeout",
    ],
    [
      "bad allow_unfiltered_writes",
      {
        DB_DRIVER: "postgres",
        DB_DSN: "postgres://u:p@h/d",
        DB_ALLOW_UNFILTERED_WRITES: "maybe",
      },
      "db_allow_unfiltered_writes",
    ],
  ];

  it.each(cases)("%s", (_label, vars, wantErr) => {
    let message = "";
    try {
      loadConfig(env(vars));
      throw new Error("expected an error, got none");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.toLowerCase()).toContain(wantErr);
  });
});

describe("resolveDriver", () => {
  it.each<[string, SqlDriver, number]>([
    ["postgres", "pgx", 5432],
    ["postgresql", "pgx", 5432],
    ["sqlserver", "sqlserver", 1433],
    ["mssql", "sqlserver", 1433],
    ["oracle", "oracle", 1521],
    ["  ORACLE  ", "oracle", 1521],
  ])("%s", (alias, sqlDriver, port) => {
    const info = resolveDriver(alias);
    expect(info).not.toBeNull();
    expect(info!.sqlDriver).toBe(sqlDriver);
    expect(info!.defaultPort).toBe(port);
  });

  it("rejects an unknown driver", () => {
    expect(resolveDriver("mysql")).toBeNull();
  });
});

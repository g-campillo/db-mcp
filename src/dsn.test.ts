import { describe, expect, it } from "vitest";
import type { SqlDriver } from "./drivers.js";
import { buildDsn, describeTarget, oracleConnectString, parseDsn, type DsnFields } from "./dsn.js";

describe("buildDsn", () => {
  it("matches the Go build's postgres format", () => {
    expect(buildDsn("pgx", { host: "h", port: 5432, user: "u", password: "p", database: "d" })).toBe(
      "postgres://u:p@h:5432/d",
    );
  });

  it("matches the Go build's sqlserver format", () => {
    expect(
      buildDsn("sqlserver", { host: "h", port: 1433, user: "u", password: "p", database: "d" }),
    ).toBe("sqlserver://u:p@h:1433?database=d");
  });

  it("matches go-ora's BuildUrl for a service name", () => {
    expect(
      buildDsn("oracle", { host: "h", port: 1521, user: "u", password: "p", database: "svc" }),
    ).toBe("oracle://u:p@h:1521/svc");
  });

  it("matches go-ora's BuildUrl for a SID", () => {
    expect(
      buildDsn("oracle", { host: "h", port: 1521, user: "u", password: "p", oracleSid: "ORCL" }),
    ).toBe("oracle://u:p@h:1521/?SID=ORCL");
  });

  it("escapes userinfo the way Go's url.UserPassword does", () => {
    // '@' ':' '/' '?' are escaped; '$' '&' '+' ',' ';' '=' are not.
    const dsn = buildDsn("pgx", {
      host: "h",
      port: 5432,
      user: "us:er",
      password: "p@ss/wo?rd",
      database: "d",
    });
    expect(dsn).toBe("postgres://us%3Aer:p%40ss%2Fwo%3Frd@h:5432/d");
  });

  it("leaves Go's unreserved-in-userinfo characters alone", () => {
    const dsn = buildDsn("pgx", {
      host: "h",
      port: 5432,
      user: "u",
      password: "a$b&c+d,e;f=g",
      database: "d",
    });
    expect(dsn).toBe("postgres://u:a$b&c+d,e;f=g@h:5432/d");
  });

  it("percent-encodes non-ASCII as UTF-8 bytes", () => {
    const dsn = buildDsn("pgx", { host: "h", port: 5432, user: "u", password: "é", database: "d" });
    expect(dsn).toBe("postgres://u:%C3%A9@h:5432/d");
  });

  it("requires a database name where the driver needs one", () => {
    expect(() => buildDsn("pgx", { host: "h", port: 5432, user: "u", password: "p" })).toThrow(
      /DB_NAME/,
    );
    expect(() => buildDsn("oracle", { host: "h", port: 1521, user: "u", password: "p" })).toThrow(
      /DB_ORACLE_SID/,
    );
  });
});

describe("parseDsn", () => {
  it("reads back a Go-written postgres DSN", () => {
    const p = parseDsn("pgx", "postgres://u:p@h:5432/d");
    expect(p).toMatchObject({ user: "u", password: "p", host: "h", port: 5432, database: "d" });
  });

  it("reads back a Go-written sqlserver DSN", () => {
    const p = parseDsn("sqlserver", "sqlserver://u:p@h:1433?database=d");
    expect(p).toMatchObject({ user: "u", password: "p", host: "h", port: 1433, database: "d" });
  });

  it("reads back a Go-written oracle service DSN", () => {
    const p = parseDsn("oracle", "oracle://u:p@h:1521/svc");
    expect(p).toMatchObject({ host: "h", port: 1521, database: "svc", oracleSid: "" });
  });

  it("reads back a Go-written oracle SID DSN", () => {
    const p = parseDsn("oracle", "oracle://u:p@h:1521/?SID=ORCL");
    expect(p).toMatchObject({ host: "h", port: 1521, database: "", oracleSid: "ORCL" });
  });

  it("percent-decodes credentials", () => {
    const p = parseDsn("pgx", "postgres://us%3Aer:p%40ss@h:5432/d");
    expect(p.user).toBe("us:er");
    expect(p.password).toBe("p@ss");
  });

  it("takes the last @ as the authority separator", () => {
    // go-ora's PathEscape leaves '@' unescaped in passwords, so a stored
    // Oracle DSN can contain a bare '@' in the password.
    const p = parseDsn("oracle", "oracle://u:p@ss@h:1521/svc");
    expect(p.user).toBe("u");
    expect(p.password).toBe("p@ss");
    expect(p.host).toBe("h");
  });

  it("rejects a string that is not a URL", () => {
    expect(() => parseDsn("pgx", "not a dsn")).toThrow(/could not parse/);
  });
});

describe("round trip", () => {
  const trips: Array<[SqlDriver, DsnFields]> = [
    ["pgx", { host: "db.example.com", port: 5432, user: "u ser", password: "p@:s/s?w&d", database: "app" }],
    ["sqlserver", { host: "db", port: 1433, user: "sa", password: "P@ssw0rd!", database: "app" }],
    ["oracle", { host: "ora", port: 1521, user: "hr", password: "s3cr%t", database: "ORCLPDB1" }],
    ["oracle", { host: "ora", port: 1521, user: "hr", password: "s3cret", oracleSid: "ORCL" }],
  ];

  it.each(trips)("%s survives build -> parse", (driver, fields) => {
    const parsed = parseDsn(driver, buildDsn(driver, fields));
    expect(parsed.user).toBe(fields.user);
    expect(parsed.password).toBe(fields.password);
    expect(parsed.host).toBe(fields.host);
    expect(parsed.port).toBe(fields.port);
    expect(parsed.database).toBe(fields.database ?? "");
    expect(parsed.oracleSid).toBe(fields.oracleSid ?? "");
  });
});

describe("oracleConnectString", () => {
  it("uses Easy Connect syntax for a service name", () => {
    expect(oracleConnectString(parseDsn("oracle", "oracle://u:p@h:1521/svc"))).toBe("h:1521/svc");
  });

  it("uses an embedded connect descriptor for a SID", () => {
    expect(oracleConnectString(parseDsn("oracle", "oracle://u:p@h:1521/?SID=ORCL"))).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))",
    );
  });
});

describe("describeTarget", () => {
  it("never includes the password", () => {
    const out = describeTarget(parseDsn("pgx", "postgres://u:sup3rsecret@h:5432/d"));
    expect(out).toBe("h:5432/d");
    expect(out).not.toContain("sup3rsecret");
  });

  it("names the SID when connecting by SID", () => {
    expect(describeTarget(parseDsn("oracle", "oracle://u:p@h:1521/?SID=ORCL"))).toBe(
      "h:1521/SID=ORCL",
    );
  });
});

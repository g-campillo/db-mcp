/**
 * Connection-string assembly and parsing for the three supported drivers.
 *
 * Backward compatibility is the whole point of this module: DSNs already
 * stored in the macOS Keychain were produced by the Go build, so `buildDsn`
 * reproduces Go's escaping byte-for-byte and `parseDsn` reads those exact
 * strings back. Formats:
 *
 *   postgres://user:pass@host:5432/db
 *   sqlserver://user:pass@host:1433?database=db
 *   oracle://user:pass@host:1521/service
 *   oracle://user:pass@host:1521/?SID=ORCL
 */

import { resolveDriver, type DriverInfo, type SqlDriver } from "./drivers.js";

/** The discrete fields a DSN is assembled from. */
export interface DsnFields {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Database name; for Oracle, the service name. */
  database?: string;
  /** Oracle only, mutually exclusive with `database`. */
  oracleSid?: string;
}

/** A DSN taken apart into the pieces a driver's config object needs. */
export interface DsnParts {
  user: string;
  password: string;
  host: string;
  port: number;
  /** Database name; for Oracle, the service name. Empty when connecting by SID. */
  database: string;
  /** Oracle only. */
  oracleSid: string;
  options: Record<string, string>;
}

// --- Go net/url escaping ------------------------------------------------
//
// Go's url package escapes per-context; reproducing the three contexts it uses
// keeps generated DSNs identical to the Go build's. Escaping applies to UTF-8
// bytes and emits uppercase hex, as Go does.

const UNRESERVED = "-_.~";

function escapeWith(s: string, allowed: string, spaceAsPlus = false): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(byte);
    const isAlnum =
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
    if (isAlnum || UNRESERVED.includes(c) || allowed.includes(c)) {
      out += c;
    } else if (spaceAsPlus && c === " ") {
      out += "+";
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Go's encodeUserPassword: escapes '@', '/', '?' and ':' from the reserved set. */
function escapeUserinfo(s: string): string {
  return escapeWith(s, "$&+,;=");
}

/** Go's encodePath (used by url.URL.String() for the path): escapes only '?'. */
function escapePath(s: string): string {
  return escapeWith(s, "$&+,/:;=@");
}

/** Go's url.PathEscape / encodePathSegment: escapes '/', ';', ',' and '?'. */
function escapePathSegment(s: string): string {
  return escapeWith(s, "$&+:=@");
}

/** Go's url.QueryEscape: everything but unreserved, space becomes '+'. */
function escapeQuery(s: string): string {
  return escapeWith(s, "", true);
}

// --- build ---------------------------------------------------------------

/**
 * Assembles a driver-native connection string from discrete fields. Used when
 * DB_DSN / DB_DSN_CMD are not set, and by the keychain CLI when storing a new
 * connection.
 */
export function buildDsn(sqlDriver: SqlDriver, f: DsnFields): string {
  const hostport = `${f.host}:${f.port}`;
  const userinfo = `${escapeUserinfo(f.user)}:${escapeUserinfo(f.password)}`;
  const database = f.database ?? "";
  const sid = f.oracleSid ?? "";

  switch (sqlDriver) {
    case "pgx":
      if (database === "") throw new Error("DB_NAME is required for postgres");
      return `postgres://${userinfo}@${hostport}/${escapePath(database)}`;

    case "sqlserver":
      if (database === "") throw new Error("DB_NAME is required for sqlserver");
      return `sqlserver://${userinfo}@${hostport}?database=${escapeQuery(database)}`;

    case "oracle": {
      // Matches go-ora's BuildUrl: PathEscape on user, password and service.
      const oraUser = escapePathSegment(f.user);
      const oraPass = escapePathSegment(f.password);
      if (sid !== "") {
        return `oracle://${oraUser}:${oraPass}@${hostport}/?SID=${escapeQuery(sid)}`;
      }
      if (database === "") {
        throw new Error("oracle requires DB_NAME (service name) or DB_ORACLE_SID");
      }
      return `oracle://${oraUser}:${oraPass}@${hostport}/${escapePathSegment(database)}`;
    }
  }
}

// --- parse ---------------------------------------------------------------

/**
 * Takes a stored DSN apart. `pg` consumes its connection string directly, but
 * mssql and oracledb need config objects — and `db-mcp test` wants to report
 * the target without ever printing the secret.
 */
export function parseDsn(sqlDriver: SqlDriver, dsn: string): DsnParts {
  let u: URL;
  try {
    u = new URL(dsn.trim());
  } catch {
    throw new Error(`could not parse the connection string as a URL`);
  }

  const options: Record<string, string> = {};
  for (const [k, v] of u.searchParams) options[k.toLowerCase()] = v;

  const parts: DsnParts = {
    user: safeDecode(u.username),
    password: safeDecode(u.password),
    host: decodeURIComponent(u.hostname),
    port: u.port === "" ? 0 : Number(u.port),
    database: "",
    oracleSid: "",
    options,
  };

  // The path is "/name" for postgres and oracle service connections, and
  // empty (or "/") when the target rides in the query string instead.
  const pathName = safeDecode(u.pathname.replace(/^\//, ""));

  switch (sqlDriver) {
    case "pgx":
      parts.database = pathName;
      break;
    case "sqlserver":
      parts.database = options["database"] ?? pathName;
      break;
    case "oracle": {
      const sid = options["sid"];
      if (sid !== undefined && sid !== "") parts.oracleSid = sid;
      else parts.database = pathName;
      break;
    }
  }
  return parts;
}

/**
 * The URL API leaves userinfo percent-encoded. Decode it, but tolerate a stray
 * '%' that isn't a valid escape rather than throwing — a password may
 * legitimately contain one if it was stored without escaping.
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The connect string node-oracledb's Thin mode expects. A service name uses
 * Easy Connect syntax; a SID has no Easy Connect form and must be given as an
 * embedded connect descriptor.
 */
export function oracleConnectString(parts: DsnParts): string {
  if (parts.oracleSid !== "") {
    return (
      `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${parts.host})(PORT=${parts.port}))` +
      `(CONNECT_DATA=(SID=${parts.oracleSid})))`
    );
  }
  return `${parts.host}:${parts.port}/${parts.database}`;
}

/**
 * Infers the driver from a DSN's URL scheme. Every DSN db-mcp stores names its
 * driver up front ("postgres://", "sqlserver://", "oracle://"), so a stored
 * connection can be probed without asking which engine it belongs to.
 */
export function driverFromDsn(dsn: string): DriverInfo | null {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(dsn.trim())?.[1];
  return scheme ? resolveDriver(scheme) : null;
}

/** A human-readable target for CLI output. Never includes the password. */
export function describeTarget(parts: DsnParts): string {
  const target = parts.oracleSid !== "" ? `SID=${parts.oracleSid}` : parts.database;
  const where = parts.port ? `${parts.host}:${parts.port}` : parts.host;
  return target ? `${where}/${target}` : where;
}

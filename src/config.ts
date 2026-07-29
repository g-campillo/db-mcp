/**
 * The one database connection this process serves, built from the DB_*
 * environment variables set in the project's local .mcp.json.
 *
 * There is no machine-global config file: a project reaches exactly the
 * database its own .mcp.json names, and nothing else.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDriver, type SqlDriver } from "./drivers.js";
import { parseGoDuration } from "./duration.js";
import { appConfigDir } from "./paths.js";
import { parsePerms, type PermSet } from "./permissions.js";

export interface ResolvedConfig {
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  password: string;
  passwordCmd: string;
  database: string;
  oracleSid: string;
  /** Full driver-native connection string; bypasses buildDsn. */
  dsn: string;
  /** Command whose stdout is the full DSN (e.g. macOS Keychain). */
  dsnCmd: string;
  allowUnfilteredWrites: boolean;
  maxRows: number;
  maxCellBytes: number;
  maxResultBytes: number;

  sqlDriver: SqlDriver;
  displayName: string;
  perms: PermSet;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * Builds the connection config from the environment. Never touches the
 * network or the Keychain — DB_DSN_CMD is resolved lazily on first use, so a
 * database being unreachable can't fail startup.
 */
export function loadConfig(env: Env = process.env): ResolvedConfig {
  const trimmed = (k: string): string => (env[k] ?? "").trim();

  if (trimmed("DB_DRIVER") === "") {
    throw new Error(
      "no database configured: set DB_DRIVER plus either DB_DSN_CMD (a command yielding the full connection string) or DB_HOST/DB_USER/DB_NAME in this project's .mcp.json env",
    );
  }

  const driver = trimmed("DB_DRIVER");
  const info = resolveDriver(driver);
  if (!info) {
    throw new Error(`unsupported driver "${driver}" (use postgres, sqlserver or oracle)`);
  }

  const dsn = trimmed("DB_DSN");
  const dsnCmd = trimmed("DB_DSN_CMD");
  const password = env["DB_PASSWORD"] ?? ""; // never trim a password
  const passwordCmd = trimmed("DB_PASSWORD_CMD");
  let host = trimmed("DB_HOST");
  let user = trimmed("DB_USER");
  const database = trimmed("DB_NAME");
  const oracleSid = trimmed("DB_ORACLE_SID");

  let port = 0;
  const portText = trimmed("DB_PORT");
  if (portText !== "") {
    port = Number(portText);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid DB_PORT "${portText}"`);
    }
  }

  let maxRows = 0;
  const maxRowsText = trimmed("DB_MAX_ROWS");
  if (maxRowsText !== "") {
    maxRows = Number(maxRowsText);
    if (!Number.isInteger(maxRows) || maxRows <= 0) {
      throw new Error(`invalid DB_MAX_ROWS "${maxRowsText}"`);
    }
  }

  let allowUnfilteredWrites = false;
  const allowText = trimmed("DB_ALLOW_UNFILTERED_WRITES");
  if (allowText !== "") {
    const parsed = parseGoBool(allowText);
    if (parsed === null) {
      throw new Error(`invalid DB_ALLOW_UNFILTERED_WRITES "${allowText}" (use true/false)`);
    }
    allowUnfilteredWrites = parsed;
  }

  // In DSN mode the connection string carries host/user/credentials, so the
  // discrete fields are not required.
  if (dsn !== "" || dsnCmd !== "") {
    if (dsn !== "" && dsnCmd !== "") {
      throw new Error("DB_DSN and DB_DSN_CMD are mutually exclusive");
    }
    if (password !== "" || passwordCmd !== "") {
      throw new Error(
        "DB_DSN/DB_DSN_CMD carry the credentials, so cannot be combined with DB_PASSWORD/DB_PASSWORD_CMD",
      );
    }
  } else {
    if (host === "") {
      throw new Error("host is required (set DB_HOST, or use DB_DSN_CMD)");
    }
    if (user === "") {
      throw new Error("user is required (set DB_USER, or use DB_DSN_CMD)");
    }
    if (port === 0) port = info.defaultPort;
    if (password !== "" && passwordCmd !== "") {
      throw new Error("DB_PASSWORD and DB_PASSWORD_CMD are mutually exclusive");
    }
    switch (info.sqlDriver) {
      case "pgx":
      case "sqlserver":
        if (database === "") {
          throw new Error(`database is required for ${info.displayName} (set DB_NAME)`);
        }
        break;
      case "oracle":
        if (database !== "" === (oracleSid !== "")) {
          throw new Error(
            "oracle requires exactly one of DB_NAME (service name) or DB_ORACLE_SID",
          );
        }
        break;
    }
  }

  const perms = parsePerms(env["DB_PERMISSIONS"] ?? "");

  let timeoutMs = 30_000;
  const timeoutText = trimmed("DB_QUERY_TIMEOUT");
  if (timeoutText !== "") {
    let parsed: number;
    try {
      parsed = parseGoDuration(timeoutText);
    } catch {
      parsed = NaN;
    }
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid query_timeout "${timeoutText}" (use a Go duration like 30s)`);
    }
    timeoutMs = parsed;
  }

  // DSN mode leaves the discrete fields empty; they are informational only.
  if (dsn !== "" || dsnCmd !== "") {
    host = "";
    user = "";
  }

  return {
    name: "default",
    driver,
    host,
    port,
    user,
    password,
    passwordCmd,
    database,
    oracleSid,
    dsn,
    dsnCmd,
    allowUnfilteredWrites,
    maxRows: maxRows === 0 ? 500 : maxRows,
    maxCellBytes: 8192,
    maxResultBytes: 0,
    sqlDriver: info.sqlDriver,
    displayName: info.displayName,
    perms,
    timeoutMs,
  };
}

/** Go's strconv.ParseBool accepts these spellings and nothing else. */
function parseGoBool(s: string): boolean | null {
  switch (s) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
  }
  return null;
}

/**
 * Nags once on stderr if the retired machine-global config file is still on
 * disk. It is no longer read: that ambient file let any project reach every
 * connection listed in it. Credentials now live per-project in .mcp.json env
 * plus the macOS Keychain.
 */
export function warnStaleGlobalConfig(): void {
  let path: string;
  try {
    path = join(appConfigDir(), "config.json");
  } catch {
    return;
  }
  if (existsSync(path)) {
    process.stderr.write(
      `db-mcp: warning: ${path} is no longer read; move each project's connection into its .mcp.json env (DB_DRIVER + DB_PERMISSIONS + DB_DSN_CMD) and delete this file\n`,
    );
  }
}

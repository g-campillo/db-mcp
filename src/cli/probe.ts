import { errorMessage } from "../errors.js";
import type { ResolvedConfig } from "../config.js";
import { openAdapter } from "../db/open.js";
import { describeTarget, parseDsn } from "../dsn.js";
import { parsePerms } from "../permissions.js";
import type { DriverInfo, SqlDriver } from "../drivers.js";

export interface ProbeResult {
  ok: boolean;
  driver: string;
  /** host:port/database — never contains the password. */
  target: string;
  /** Server version banner, when the connection succeeded. */
  version?: string;
  elapsedMs: number;
  error?: string;
}

/**
 * Opens the connection, runs a trivial statement and reports what happened.
 * The DSN is never echoed — only the host and database it points at, so probe
 * output is safe to paste into a bug report.
 */
export async function probeConnection(
  cfg: ResolvedConfig,
  dsn: string,
): Promise<ProbeResult> {
  const target = safeTarget(cfg.sqlDriver, dsn);
  const started = Date.now();

  let adapter: Awaited<ReturnType<typeof openAdapter>> | null = null;
  try {
    adapter = await openAdapter(cfg, dsn);
    const version = await adapter.probe();
    return { ok: true, driver: cfg.displayName, target, version, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      driver: cfg.displayName,
      target,
      elapsedMs: Date.now() - started,
      error: errorMessage(err),
    };
  } finally {
    if (adapter) await adapter.close().catch(() => {});
  }
}

/** Describes the target, falling back to a placeholder on an unparseable DSN. */
function safeTarget(sqlDriver: SqlDriver, dsn: string): string {
  try {
    return describeTarget(parseDsn(sqlDriver, dsn));
  } catch {
    return "(unparseable connection string)";
  }
}

/**
 * A minimal config for probing a DSN that has no .mcp.json behind it. Only the
 * driver identity and the caps a probe can touch matter; the timeout is shorter
 * than the server's default so a wrong host fails while you are still watching.
 */
export function probeConfig(info: DriverInfo): ResolvedConfig {
  return {
    name: "default",
    driver: info.displayName,
    host: "",
    port: 0,
    user: "",
    password: "",
    passwordCmd: "",
    database: "",
    oracleSid: "",
    dsn: "",
    dsnCmd: "",
    allowUnfilteredWrites: false,
    maxRows: 500,
    maxCellBytes: 8192,
    maxResultBytes: 0,
    sqlDriver: info.sqlDriver,
    displayName: info.displayName,
    perms: parsePerms("read"),
    timeoutMs: 15_000,
  };
}

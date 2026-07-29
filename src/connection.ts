import { errorMessage } from "./errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedConfig } from "./config.js";
import { openAdapter } from "./db/open.js";
import type { DbAdapter } from "./db/types.js";
import { buildDsn } from "./dsn.js";

const execFileAsync = promisify(execFile);

/**
 * The configured connection with a lazily opened handle, so a database that
 * happens to be down never blocks startup — only the first tool call that
 * needs it.
 */
export class Connection {
  private opening: Promise<DbAdapter> | null = null;
  private adapter: DbAdapter | null = null;

  constructor(readonly cfg: ResolvedConfig) {}

  /**
   * Returns the cached handle, opening it on first use. Failures are **not**
   * cached: a database that was down is retried on the next call without
   * restarting the server.
   */
  async get(): Promise<DbAdapter> {
    if (this.adapter) return this.adapter;
    if (!this.opening) {
      this.opening = (async () => {
        const dsn = await this.resolveDsn();
        const adapter = await openAdapter(this.cfg, dsn);
        this.adapter = adapter;
        return adapter;
      })();
      // Clear the memo on failure so the next call retries from scratch.
      this.opening.catch(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  /**
   * Produces the connection string: a full DSN pulled from DB_DSN_CMD (e.g. the
   * macOS Keychain) or DB_DSN verbatim, otherwise assembled from the discrete
   * fields with the password possibly coming from DB_PASSWORD_CMD.
   */
  async resolveDsn(): Promise<string> {
    const { cfg } = this;
    if (cfg.dsnCmd !== "") {
      return runCmd(cfg.dsnCmd, `dsn_cmd for ${cfg.name}`);
    }
    if (cfg.dsn !== "") return cfg.dsn;

    let password = cfg.password;
    if (cfg.passwordCmd !== "") {
      password = await runCmd(cfg.passwordCmd, `password_cmd for ${cfg.name}`);
    }
    return buildDsn(cfg.sqlDriver, {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.database,
      oracleSid: cfg.oracleSid,
    });
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    this.opening = null;
    if (adapter) await adapter.close().catch(() => {});
  }
}

/**
 * Runs a shell command and returns its trimmed stdout, used to pull a secret (a
 * password or a whole DSN) from the macOS Keychain via `security`.
 */
export async function runCmd(cmd: string, label: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", cmd], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.replace(/[\r\n]+$/, "");
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const message = errorMessage(err);
    throw new Error(stderr ? `${label}: ${message}: ${stderr}` : `${label}: ${message}`);
  }
}

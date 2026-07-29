import { errorMessage } from "./errors.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appConfigDir } from "./paths.js";

/**
 * One JSONL record per agent-authored statement (the `query` and `explain`
 * tools). Introspection tools run fixed catalog SQL and are not audited;
 * neither are authorization denials, since nothing was executed.
 */
export interface AuditRecord {
  ts?: string;
  connection: string;
  tool: string;
  op: string;
  sql: string;
  rows?: number;
  rows_affected?: number;
  duration_ms: number;
  error?: string;
}

/**
 * Appends audit records to a log file. `open` returns null when auditing is
 * disabled; a null auditor is safe to pass around and `log` on it is a no-op.
 *
 * Writes are synchronous, which keeps records ordered and whole the way Go's
 * mutex-serialised writer did. There is no rotation and no per-line fsync: the
 * file is plain JSONL for external tooling to rotate.
 */
export class Auditor {
  private constructor(private readonly path: string) {}

  /**
   * Opens (or creates) the audit log, defaulting to
   * <UserConfigDir>/db-mcp/audit.jsonl (override with DB_AUDIT_PATH). Returns
   * null when DB_AUDIT_DISABLED is set. Open failures throw: a safety feature
   * that silently no-ops is worse than a crash at startup.
   */
  static open(env: Record<string, string | undefined> = process.env): Auditor | null {
    const disabled = (env["DB_AUDIT_DISABLED"] ?? "").trim();
    if (disabled !== "" && parseBool(disabled) === true) return null;

    let path = (env["DB_AUDIT_PATH"] ?? "").trim();
    if (path === "") path = join(appConfigDir(), "audit.jsonl");

    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // Create it now so a permission problem surfaces at startup, not mid-query.
    appendFileSync(path, "", { mode: 0o600 });
    return new Auditor(path);
  }

  /** Appends one record. Write errors go to stderr — never the MCP stdout stream. */
  log(rec: AuditRecord): void {
    const line = JSON.stringify({ ...rec, ts: new Date().toISOString() });
    try {
      appendFileSync(this.path, line + "\n", { mode: 0o600 });
    } catch (err) {
      process.stderr.write(
        `db-mcp: audit: write: ${errorMessage(err)}\n`,
      );
    }
  }
}

function parseBool(s: string): boolean | null {
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

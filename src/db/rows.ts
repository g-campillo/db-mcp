import type { ResolvedConfig } from "../config.js";
import { normalize } from "./normalize.js";
import type { QueryResult } from "./types.js";

/**
 * Accumulates rows under the connection's caps, telling the caller when to stop
 * pulling. Adapters differ in *how* they stop (a cursor read size, a stream
 * cancel, a driver-native maxRows) but all share this accounting so the row
 * limit, the byte limit and the truncation markers behave identically across
 * the three drivers — as they did when Go shared one `scanRows`.
 */
export class RowCollector {
  private readonly maxRows: number;
  private readonly maxCellBytes: number;
  private readonly maxResultBytes: number;
  private size = 0;

  readonly rows: Record<string, unknown>[] = [];
  columns: string[] = [];
  private truncated = false;
  private truncatedReason = "";

  constructor(cfg: Pick<ResolvedConfig, "maxRows" | "maxCellBytes" | "maxResultBytes">) {
    this.maxRows = cfg.maxRows;
    this.maxCellBytes = cfg.maxCellBytes;
    this.maxResultBytes = cfg.maxResultBytes;
  }

  /**
   * Normalises and stores one row. Returns false once the caps are reached and
   * the caller should stop consuming — mirroring Go's `break` out of the scan
   * loop, including checking the row cap *before* appending so an extra row
   * seen is what proves truncation.
   */
  add(raw: Record<string, unknown>): boolean {
    if (this.rows.length >= this.maxRows) {
      this.truncated = true;
      this.truncatedReason = "row limit";
      return false;
    }

    const row: Record<string, unknown> = {};
    for (const c of this.columns) {
      row[c] = normalize(raw[c], this.maxCellBytes);
    }
    this.rows.push(row);

    if (this.maxResultBytes > 0) {
      // Approximate accounting: string lengths plus a flat 16 bytes for every
      // other value.
      for (const c of this.columns) {
        this.size += c.length;
        const v = row[c];
        this.size += typeof v === "string" ? v.length : 16;
      }
      if (this.size > this.maxResultBytes) {
        this.truncated = true;
        this.truncatedReason = "byte limit";
        return false;
      }
    }
    return true;
  }

  /** True once a cap has been hit, so adapters can stop early. */
  get done(): boolean {
    return this.truncated;
  }

  /** The number of rows to request so that hitting the cap is detectable. */
  get readSize(): number {
    return this.maxRows + 1;
  }

  finish(): QueryResult {
    const res: QueryResult = {
      columns: this.columns.length > 0 ? this.columns : undefined,
      rows: this.rows,
      row_count: this.rows.length,
    };
    if (this.truncated) {
      res.truncated = true;
      res.truncated_reason = this.truncatedReason;
    }
    return res;
  }
}

/** The result shape for a statement that reports rows affected instead of rows. */
export function affectedResult(rowsAffected: number | undefined): QueryResult {
  const res: QueryResult = { rows: [], row_count: 0 };
  if (rowsAffected !== undefined) res.rows_affected = rowsAffected;
  return res;
}

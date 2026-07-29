import type { ResolvedConfig } from "../config.js";

/**
 * The JSON-serialisable result returned to the agent. Field names match the
 * Go build's JSON tags exactly; optional fields are omitted when unset, which
 * `JSON.stringify` does for `undefined` just as Go's `omitempty` does for zero
 * values.
 */
export interface QueryResult {
  columns?: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
  truncated_reason?: string;
  rows_affected?: number;
}

/** A describe/search result: several named sections, each its own result set. */
export type SectionResult = Record<string, QueryResult>;

/**
 * The seam between the tools and the three drivers. Go got a uniform interface
 * from `database/sql`; Node's drivers share nothing, so each adapter owns its
 * pool, placeholder syntax, timeout mechanism, row-cap strategy and catalog SQL.
 */
export interface DbAdapter {
  readonly cfg: ResolvedConfig;

  /** Runs a row-returning statement, capped at cfg.maxRows. */
  runRead(sql: string): Promise<QueryResult>;

  /** Runs a non-row-returning statement and reports rows affected. */
  runWrite(sql: string): Promise<QueryResult>;

  /** Base tables and views, optionally filtered by schema/owner. */
  listTables(schema: string): Promise<QueryResult>;

  /** Columns, PK/unique constraints, foreign keys (both directions), indexes. */
  describeTable(table: string, schema: string): Promise<SectionResult>;

  /** Tables and/or columns matching a case-insensitive name substring. */
  searchSchema(pattern: string, type: string, schema: string): Promise<SectionResult>;

  /** The engine's plan for a read statement, without executing it. */
  explain(sql: string): Promise<QueryResult>;

  /** Verifies the connection works and reports the server version. */
  probe(): Promise<string>;

  close(): Promise<void>;
}

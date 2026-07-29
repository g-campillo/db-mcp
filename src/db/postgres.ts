import { errorMessage } from "../errors.js";
import pg from "pg";
import Cursor from "pg-cursor";
import type { ResolvedConfig } from "../config.js";
import { RowCollector, affectedResult } from "./rows.js";
import type { DbAdapter, QueryResult, SectionResult } from "./types.js";

const { Pool } = pg;

/**
 * PostgreSQL via `pg`. Reads stream through a server-side cursor so the row cap
 * bounds what is fetched, not just what is returned — an agent running
 * `SELECT *` on a large table never materialises it.
 */
export class PostgresAdapter implements DbAdapter {
  private readonly pool: pg.Pool;

  constructor(readonly cfg: ResolvedConfig, dsn: string) {
    this.pool = new Pool({
      connectionString: dsn,
      max: 5,
      idleTimeoutMillis: 5 * 60 * 1000,
      connectionTimeoutMillis: 10_000,
      // Server-side cancellation, so a runaway query is stopped in the engine
      // rather than merely abandoned by the client.
      statement_timeout: this.cfg.timeoutMs,
    });
  }

  static async open(cfg: ResolvedConfig, dsn: string): Promise<PostgresAdapter> {
    const adapter = new PostgresAdapter(cfg, dsn);
    const client = await adapter.pool.connect();
    client.release();
    return adapter;
  }

  async runRead(sql: string): Promise<QueryResult> {
    return this.queryRows(sql);
  }

  async runWrite(sql: string): Promise<QueryResult> {
    const res = await this.pool.query(sql);
    return affectedResult(res.rowCount ?? undefined);
  }

  /** Streams a result set through a cursor, stopping as soon as a cap is hit. */
  private async queryRows(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const client = await this.pool.connect();
    const cursor = client.query(new Cursor(sql, params));
    const collector = new RowCollector(this.cfg);
    try {
      // Reading one more than the cap is what makes truncation detectable.
      const { rows, fields } = await readCursor(cursor, collector.readSize);
      collector.columns = fields.map((f) => f.name);
      for (const row of rows) {
        if (!collector.add(row as Record<string, unknown>)) break;
      }
      return collector.finish();
    } finally {
      await cursor.close().catch(() => {});
      client.release();
    }
  }

  async listTables(schema: string): Promise<QueryResult> {
    let q =
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW')";
    const args: unknown[] = [];
    if (schema !== "") {
      q += " AND table_schema = $1";
      args.push(schema);
    } else {
      q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')";
    }
    q += " ORDER BY table_schema, table_name";
    return this.queryRows(q, args);
  }

  async describeTable(table: string, schema: string): Promise<SectionResult> {
    const out: SectionResult = {};
    for (const s of pgDescribe(table, schema)) {
      try {
        out[s.key] = await this.queryRows(s.q, s.args);
      } catch (err) {
        throw new Error(`${s.key}: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  async searchSchema(pattern: string, type: string, schema: string): Promise<SectionResult> {
    const out: SectionResult = {};
    if (type === "" || type === "table") {
      let q =
        "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW') AND LOWER(table_name) LIKE '%' || LOWER($1) || '%'";
      const args: unknown[] = [pattern];
      if (schema !== "") {
        q += " AND table_schema = $2";
        args.push(schema);
      } else {
        q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')";
      }
      q += " ORDER BY table_schema, table_name";
      out["tables"] = await this.queryRows(q, args).catch(rethrow("tables"));
    }
    if (type === "" || type === "column") {
      let q =
        "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE LOWER(column_name) LIKE '%' || LOWER($1) || '%'";
      const args: unknown[] = [pattern];
      if (schema !== "") {
        q += " AND table_schema = $2";
        args.push(schema);
      } else {
        q += " AND table_schema NOT IN ('pg_catalog', 'information_schema')";
      }
      q += " ORDER BY table_schema, table_name, ordinal_position";
      out["columns"] = await this.queryRows(q, args).catch(rethrow("columns"));
    }
    return out;
  }

  async explain(sql: string): Promise<QueryResult> {
    return this.queryRows(`EXPLAIN ${sql}`);
  }

  async probe(): Promise<string> {
    const res = await this.pool.query("SELECT version() AS version");
    return String(res.rows[0]?.["version"] ?? "postgres");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rethrow(label: string): (err: unknown) => never {
  return (err: unknown) => {
    throw new Error(`${label}: ${errorMessage(err)}`);
  };
}

/**
 * Promisified cursor read. The callback form is the only one that also hands
 * back the result metadata, and column names are needed even when the result
 * set is empty.
 */
function readCursor(
  cursor: Cursor,
  n: number,
): Promise<{ rows: unknown[]; fields: pg.FieldDef[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => {
      if (err) reject(err);
      else resolve({ rows, fields: result?.fields ?? [] });
    });
  });
}

interface CatalogSection {
  key: string;
  q: string;
  args: unknown[];
}

/** Appends an optional schema filter with the next positional placeholder. */
function withSchema(
  q: string,
  args: unknown[],
  clause: string,
  val: string,
): [string, unknown[]] {
  if (val === "") return [q, args];
  return [q + clause + `$${args.length + 1}`, [...args, val]];
}

const PG_FK =
  "SELECT rc.constraint_name, kcu.table_schema AS from_schema, kcu.table_name AS from_table, kcu.column_name, kcu2.table_schema AS ref_schema, kcu2.table_name AS ref_table, kcu2.column_name AS ref_column FROM information_schema.referential_constraints rc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema JOIN information_schema.key_column_usage kcu2 ON kcu2.constraint_name = rc.unique_constraint_name AND kcu2.constraint_schema = rc.unique_constraint_schema AND kcu2.ordinal_position = kcu.position_in_unique_constraint";

function pgDescribe(table: string, schema: string): CatalogSection[] {
  const secs: CatalogSection[] = [];
  let q: string;
  let args: unknown[];

  [q, args] = withSchema(
    "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_name = $1",
    [table],
    " AND table_schema = ",
    schema,
  );
  secs.push({ key: "columns", q: q + " ORDER BY ordinal_position", args });

  [q, args] = withSchema(
    "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema WHERE tc.table_name = $1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')",
    [table],
    " AND tc.table_schema = ",
    schema,
  );
  secs.push({
    key: "constraints",
    q: q + " ORDER BY tc.constraint_name, kcu.ordinal_position",
    args,
  });

  [q, args] = withSchema(`${PG_FK} WHERE kcu.table_name = $1`, [table], " AND kcu.table_schema = ", schema);
  secs.push({
    key: "foreign_keys",
    q: q + " ORDER BY rc.constraint_name, kcu.ordinal_position",
    args,
  });

  [q, args] = withSchema(`${PG_FK} WHERE kcu2.table_name = $1`, [table], " AND kcu2.table_schema = ", schema);
  secs.push({
    key: "referenced_by",
    q: q + " ORDER BY rc.constraint_name, kcu.ordinal_position",
    args,
  });

  [q, args] = withSchema(
    "SELECT indexname AS index_name, indexdef AS definition FROM pg_indexes WHERE tablename = $1",
    [table],
    " AND schemaname = ",
    schema,
  );
  secs.push({ key: "indexes", q: q + " ORDER BY indexname", args });

  return secs;
}

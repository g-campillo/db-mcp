import { errorMessage } from "../errors.js";
import sql from "mssql";
import type { ResolvedConfig } from "../config.js";
import { parseDsn, type DsnParts } from "../dsn.js";
import { RowCollector, affectedResult } from "./rows.js";
import type { DbAdapter, QueryResult, SectionResult } from "./types.js";

/**
 * SQL Server via `mssql` (the pure-JS tedious driver). Reads stream row by row
 * and the request is cancelled the moment a cap is reached, so the row limit
 * bounds what is fetched rather than only what is returned.
 */
export class MssqlAdapter implements DbAdapter {
  private constructor(
    readonly cfg: ResolvedConfig,
    private readonly pool: sql.ConnectionPool,
    private readonly dsn: string,
  ) {}

  static async open(cfg: ResolvedConfig, dsn: string): Promise<MssqlAdapter> {
    const pool = new sql.ConnectionPool(mssqlConfig(cfg, parseDsn("sqlserver", dsn)));
    await pool.connect();
    return new MssqlAdapter(cfg, pool, dsn);
  }

  async runRead(sqlText: string): Promise<QueryResult> {
    return this.queryRows(sqlText);
  }

  async runWrite(sqlText: string): Promise<QueryResult> {
    const res = await this.pool.request().batch(sqlText);
    const affected = res.rowsAffected.reduce((a, b) => a + b, 0);
    return affectedResult(affected);
  }

  private queryRows(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const collector = new RowCollector(this.cfg);
      const request = this.pool.request();
      request.stream = true;
      params.forEach((v, i) => request.input(`p${i + 1}`, v));

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      request.on("recordset", (columns: sql.IColumnMetadata) => {
        collector.columns = Object.keys(columns);
      });

      request.on("row", (row: Record<string, unknown>) => {
        if (settled) return;
        if (!collector.add(row)) {
          // The capped rows are already in hand, so resolve immediately and let
          // the cancel unwind in the background rather than waiting on 'done'.
          request.cancel();
          settle(() => resolve(collector.finish()));
        }
      });

      // A cancel we asked for surfaces as an error; by then we have settled.
      request.on("error", (err: Error) => settle(() => reject(err)));
      request.on("done", () => settle(() => resolve(collector.finish())));

      // `query` wraps the text in sp_executesql, which is right for the
      // parameterised catalog queries but changes the execution context.
      // Statements the agent wrote carry no parameters and go out as a plain
      // T-SQL batch, which is what go-mssqldb did — and is what SET SHOWPLAN
      // needs in order to apply (see `explain`).
      if (params.length > 0) request.query(sqlText);
      else request.batch(sqlText);
    });
  }

  async listTables(schema: string): Promise<QueryResult> {
    let q =
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW')";
    const args: unknown[] = [];
    if (schema !== "") {
      q += " AND table_schema = @p1";
      args.push(schema);
    }
    q += " ORDER BY table_schema, table_name";
    return this.queryRows(q, args);
  }

  async describeTable(table: string, schema: string): Promise<SectionResult> {
    const out: SectionResult = {};
    for (const s of mssqlDescribe(table, schema)) {
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
        "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'VIEW') AND LOWER(table_name) LIKE '%' + LOWER(@p1) + '%'";
      const args: unknown[] = [pattern];
      if (schema !== "") {
        q += " AND table_schema = @p2";
        args.push(schema);
      }
      q += " ORDER BY table_schema, table_name";
      out["tables"] = await this.queryRows(q, args).catch(rethrow("tables"));
    }
    if (type === "" || type === "column") {
      let q =
        "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE LOWER(column_name) LIKE '%' + LOWER(@p1) + '%'";
      const args: unknown[] = [pattern];
      if (schema !== "") {
        q += " AND table_schema = @p2";
        args.push(schema);
      }
      q += " ORDER BY table_schema, table_name, ordinal_position";
      out["columns"] = await this.queryRows(q, args).catch(rethrow("columns"));
    }
    return out;
  }

  /**
   * SHOWPLAN_ALL is sticky session state: a connection left in plan mode would
   * hand plans instead of data to whoever borrows it next. Go guarded that by
   * poisoning the pooled connection on a failed reset. Here the whole thing runs
   * on a single-connection throwaway pool that is closed unconditionally, so the
   * state cannot outlive the call at all. Explain is interactive and rare, so
   * the extra connect is a fair price for not being able to get this wrong.
   *
   * Both statements must go out via `batch`. `query` wraps its text in
   * sp_executesql, and SET SHOWPLAN only governs statements in the batch itself
   * — so through `query` the plan mode is silently ignored and the statement
   * *executes*, returning data where a plan was asked for.
   */
  async explain(sqlText: string): Promise<QueryResult> {
    const pool = new sql.ConnectionPool(
      mssqlConfig(this.cfg, parseDsn("sqlserver", this.dsn), 1),
    );
    await pool.connect();
    try {
      // SET SHOWPLAN statements must be alone in their batch.
      await pool.request().batch("SET SHOWPLAN_ALL ON");
      const res = await pool.request().batch(sqlText);
      const collector = new RowCollector(this.cfg);
      const recordset = res.recordset;
      collector.columns = recordset?.columns ? Object.keys(recordset.columns) : [];
      for (const row of recordset ?? []) {
        if (!collector.add(row as Record<string, unknown>)) break;
      }
      return collector.finish();
    } finally {
      await pool.close().catch(() => {});
    }
  }

  async probe(): Promise<string> {
    const res = await this.pool.request().query("SELECT @@VERSION AS version");
    return String(res.recordset[0]?.["version"] ?? "sqlserver").split("\n")[0]!.trim();
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

function rethrow(label: string): (err: unknown) => never {
  return (err: unknown) => {
    throw new Error(`${label}: ${errorMessage(err)}`);
  };
}

/**
 * Builds tedious config from a parsed DSN. Encryption defaults to off to match
 * go-mssqldb v1.8, whose default is EncryptionOff — the TDS login packet is
 * encrypted regardless. Both settings are overridable from the DSN query string
 * (`?encrypt=true&trustservercertificate=true`), exactly as in the Go build.
 */
function mssqlConfig(cfg: ResolvedConfig, parts: DsnParts, maxPool = 5): sql.config {
  const opt = (k: string): string | undefined => parts.options[k];
  const bool = (v: string | undefined, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    const s = v.toLowerCase();
    if (s === "disable" || s === "false" || s === "0" || s === "no") return false;
    return s === "true" || s === "1" || s === "yes" || s === "strict";
  };

  return {
    server: parts.host,
    port: parts.port || 1433,
    user: parts.user,
    password: parts.password,
    database: parts.database,
    connectionTimeout: 10_000,
    requestTimeout: cfg.timeoutMs,
    pool: { max: maxPool, min: 0, idleTimeoutMillis: 5 * 60 * 1000 },
    options: {
      encrypt: bool(opt("encrypt"), false),
      trustServerCertificate: bool(opt("trustservercertificate"), false),
      ...(opt("instance") || opt("instancename")
        ? { instanceName: opt("instance") ?? opt("instancename")! }
        : {}),
      ...(opt("app name") || opt("appname")
        ? { appName: opt("app name") ?? opt("appname")! }
        : {}),
    },
  };
}

interface CatalogSection {
  key: string;
  q: string;
  args: unknown[];
}

function withSchema(
  q: string,
  args: unknown[],
  clause: string,
  val: string,
): [string, unknown[]] {
  if (val === "") return [q, args];
  return [q + clause + `@p${args.length + 1}`, [...args, val]];
}

// information_schema cannot pair multi-column FKs reliably on SQL Server (no
// position_in_unique_constraint), so the sys catalog is used instead.
const MS_FK =
  "SELECT fk.name AS constraint_name, SCHEMA_NAME(t.schema_id) AS from_schema, t.name AS from_table, pc.name AS column_name, SCHEMA_NAME(rt.schema_id) AS ref_schema, rt.name AS ref_table, rc.name AS ref_column FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id";

function mssqlDescribe(table: string, schema: string): CatalogSection[] {
  const secs: CatalogSection[] = [];
  let q: string;
  let args: unknown[];

  [q, args] = withSchema(
    "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_name = @p1",
    [table],
    " AND table_schema = ",
    schema,
  );
  secs.push({ key: "columns", q: q + " ORDER BY ordinal_position", args });

  [q, args] = withSchema(
    "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema WHERE tc.table_name = @p1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')",
    [table],
    " AND tc.table_schema = ",
    schema,
  );
  secs.push({
    key: "constraints",
    q: q + " ORDER BY tc.constraint_name, kcu.ordinal_position",
    args,
  });

  [q, args] = withSchema(`${MS_FK} WHERE t.name = @p1`, [table], " AND SCHEMA_NAME(t.schema_id) = ", schema);
  secs.push({ key: "foreign_keys", q: q + " ORDER BY fk.name, fkc.constraint_column_id", args });

  [q, args] = withSchema(`${MS_FK} WHERE rt.name = @p1`, [table], " AND SCHEMA_NAME(rt.schema_id) = ", schema);
  secs.push({ key: "referenced_by", q: q + " ORDER BY fk.name, fkc.constraint_column_id", args });

  [q, args] = withSchema(
    "SELECT i.name AS index_name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS column_name, ic.key_ordinal, ic.is_included_column FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.name IS NOT NULL AND t.name = @p1",
    [table],
    " AND SCHEMA_NAME(t.schema_id) = ",
    schema,
  );
  secs.push({ key: "indexes", q: q + " ORDER BY i.name, ic.key_ordinal", args });

  return secs;
}

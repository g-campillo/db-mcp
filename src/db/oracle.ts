import { errorMessage } from "../errors.js";
import oracledb from "oracledb";
import type { ResolvedConfig } from "../config.js";
import { oracleConnectString, parseDsn } from "../dsn.js";
import { RowCollector, affectedResult } from "./rows.js";
import type { DbAdapter, QueryResult, SectionResult } from "./types.js";

// Rows as objects, matching the map-per-row shape the other drivers produce.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// CLOBs would otherwise arrive as Lob streams, which cannot be serialised into
// a tool result; as strings they hit the same cell-size cap as any other text.
oracledb.fetchAsString = [oracledb.CLOB];

/**
 * Oracle via node-oracledb in **Thin mode** — pure JavaScript, no Oracle
 * Instant Client, matching the Go build's use of a pure-Go driver. Connections
 * are made by host + port with a service name or SID; wallets and TNS aliases
 * are not supported, as before.
 */
export class OracleAdapter implements DbAdapter {
  private constructor(
    readonly cfg: ResolvedConfig,
    private readonly pool: oracledb.Pool,
  ) {}

  static async open(cfg: ResolvedConfig, dsn: string): Promise<OracleAdapter> {
    const parts = parseDsn("oracle", dsn);
    const pool = await oracledb.createPool({
      user: parts.user,
      password: parts.password,
      connectString: oracleConnectString(parts),
      poolMin: 0,
      poolMax: 5,
      poolTimeout: 300,
    });
    return new OracleAdapter(cfg, pool);
  }

  /** Borrows a connection with the query timeout applied. */
  private async withConnection<T>(
    fn: (conn: oracledb.Connection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.pool.getConnection();
    conn.callTimeout = this.cfg.timeoutMs;
    try {
      return await fn(conn);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  async runRead(sqlText: string): Promise<QueryResult> {
    return this.queryRows(sqlText);
  }

  async runWrite(sqlText: string): Promise<QueryResult> {
    return this.withConnection(async (conn) => {
      const res = await conn.execute(sqlText, [], { autoCommit: true });
      return affectedResult(res.rowsAffected);
    });
  }

  private async queryRows(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
    const collector = new RowCollector(this.cfg);
    return this.withConnection(async (conn) => {
      // maxRows is enforced by the driver, so the cap bounds the fetch itself.
      // One extra row is requested so truncation is detectable.
      const res = await conn.execute<Record<string, unknown>>(sqlText, params as oracledb.BindParameters, {
        maxRows: collector.readSize,
      });
      collector.columns = (res.metaData ?? []).map((m) => m.name);
      for (const row of res.rows ?? []) {
        if (!collector.add(row)) break;
      }
      return collector.finish();
    });
  }

  async listTables(schema: string): Promise<QueryResult> {
    // all_objects/user_objects covers tables and views in one query.
    // Materialised views are deliberately excluded.
    if (schema !== "") {
      return this.queryRows(
        "SELECT owner AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM all_objects WHERE object_type IN ('TABLE', 'VIEW') AND owner = :1 ORDER BY object_name",
        [schema.toUpperCase()],
      );
    }
    return this.queryRows(
      "SELECT USER AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM user_objects WHERE object_type IN ('TABLE', 'VIEW') ORDER BY object_name",
    );
  }

  async describeTable(table: string, schema: string): Promise<SectionResult> {
    const out: SectionResult = {};
    for (const s of oracleDescribe(table.toUpperCase(), schema.toUpperCase())) {
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
      const [q, args] =
        schema !== ""
          ? [
              "SELECT owner AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM all_objects WHERE object_type IN ('TABLE', 'VIEW') AND LOWER(object_name) LIKE '%' || LOWER(:1) || '%' AND owner = :2 ORDER BY owner, object_name",
              [pattern, schema.toUpperCase()],
            ]
          : [
              "SELECT USER AS table_schema, object_name AS table_name, CASE object_type WHEN 'TABLE' THEN 'BASE TABLE' ELSE 'VIEW' END AS table_type FROM user_objects WHERE object_type IN ('TABLE', 'VIEW') AND LOWER(object_name) LIKE '%' || LOWER(:1) || '%' ORDER BY object_name",
              [pattern],
            ];
      out["tables"] = await this.queryRows(q as string, args as unknown[]).catch(rethrow("tables"));
    }
    if (type === "" || type === "column") {
      const [q, args] =
        schema !== ""
          ? [
              "SELECT owner AS table_schema, table_name, column_name, data_type FROM all_tab_columns WHERE LOWER(column_name) LIKE '%' || LOWER(:1) || '%' AND owner = :2 ORDER BY owner, table_name, column_id",
              [pattern, schema.toUpperCase()],
            ]
          : [
              "SELECT USER AS table_schema, table_name, column_name, data_type FROM user_tab_columns WHERE LOWER(column_name) LIKE '%' || LOWER(:1) || '%' ORDER BY table_name, column_id",
              [pattern],
            ];
      out["columns"] = await this.queryRows(q as string, args as unknown[]).catch(rethrow("columns"));
    }
    return out;
  }

  /**
   * EXPLAIN PLAN writes into PLAN_TABLE and DBMS_XPLAN reads it back, but those
   * rows are session-private — both statements must run on the same connection.
   */
  async explain(sqlText: string): Promise<QueryResult> {
    const collector = new RowCollector(this.cfg);
    return this.withConnection(async (conn) => {
      try {
        await conn.execute(`EXPLAIN PLAN FOR ${sqlText}`);
        const res = await conn.execute<Record<string, unknown>>(
          "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())",
          [],
          { maxRows: collector.readSize },
        );
        collector.columns = (res.metaData ?? []).map((m) => m.name);
        for (const row of res.rows ?? []) {
          if (!collector.add(row)) break;
        }
        return collector.finish();
      } catch (err) {
        throw oracleExplainHint(err);
      }
    });
  }

  async probe(): Promise<string> {
    return this.withConnection(async (conn) => {
      try {
        const res = await conn.execute<Record<string, unknown>>(
          "SELECT banner AS version FROM v$version WHERE ROWNUM = 1",
        );
        const banner = res.rows?.[0]?.["VERSION"];
        if (banner) return String(banner);
      } catch {
        // v$version needs a grant that a least-privilege user may not hold.
      }
      await conn.execute("SELECT 1 FROM DUAL");
      return "oracle (version not readable by this user)";
    });
  }

  async close(): Promise<void> {
    await this.pool.close(0);
  }
}

function rethrow(label: string): (err: unknown) => never {
  return (err: unknown) => {
    throw new Error(`${label}: ${errorMessage(err)}`);
  };
}

function oracleExplainHint(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.message.includes("ORA-00942") || e.message.includes("ORA-02404")) {
    return new Error(
      `${e.message} (PLAN_TABLE appears unavailable for this user; a DBA can create it via $ORACLE_HOME/rdbms/admin/utlxplan.sql)`,
    );
  }
  return e;
}

interface CatalogSection {
  key: string;
  q: string;
  args: unknown[];
}

/**
 * Expects table and schema already upper-cased. With no schema it uses the
 * user_* views (the current user's objects), matching the list_tables
 * convention; the referenced side of FK joins always uses all_* because a
 * referenced constraint can belong to another owner.
 */
function oracleDescribe(table: string, schema: string): CatalogSection[] {
  const secs: CatalogSection[] = [];

  if (schema !== "") {
    secs.push({
      key: "columns",
      q: "SELECT column_name, data_type, nullable, data_length, data_precision, data_scale, data_default FROM all_tab_columns WHERE table_name = :1 AND owner = :2 ORDER BY column_id",
      args: [table, schema],
    });
    secs.push({
      key: "constraints",
      q: "SELECT ac.constraint_name, ac.constraint_type, acc.column_name, acc.position FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name WHERE ac.table_name = :1 AND ac.constraint_type IN ('P', 'U') AND ac.owner = :2 ORDER BY ac.constraint_name, acc.position",
      args: [table, schema],
    });
    secs.push({
      key: "foreign_keys",
      q: "SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rc.owner AS ref_schema, rc.table_name AS ref_table, rcc.column_name AS ref_column FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE ac.constraint_type = 'R' AND ac.table_name = :1 AND ac.owner = :2 ORDER BY ac.constraint_name, acc.position",
      args: [table, schema],
    });
    secs.push({
      key: "referenced_by",
      q: "SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rcc.column_name AS ref_column FROM all_constraints rc JOIN all_constraints ac ON ac.r_owner = rc.owner AND ac.r_constraint_name = rc.constraint_name AND ac.constraint_type = 'R' JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE rc.table_name = :1 AND rc.owner = :2 ORDER BY ac.owner, ac.constraint_name, acc.position",
      args: [table, schema],
    });
    secs.push({
      key: "indexes",
      q: "SELECT ai.index_name, ai.uniqueness, aic.column_name, aic.column_position FROM all_indexes ai JOIN all_ind_columns aic ON aic.index_owner = ai.owner AND aic.index_name = ai.index_name WHERE ai.table_name = :1 AND ai.table_owner = :2 ORDER BY ai.index_name, aic.column_position",
      args: [table, schema],
    });
    return secs;
  }

  secs.push({
    key: "columns",
    q: "SELECT column_name, data_type, nullable, data_length, data_precision, data_scale, data_default FROM all_tab_columns WHERE table_name = :1 ORDER BY column_id",
    args: [table],
  });
  secs.push({
    key: "constraints",
    q: "SELECT uc.constraint_name, uc.constraint_type, ucc.column_name, ucc.position FROM user_constraints uc JOIN user_cons_columns ucc ON ucc.constraint_name = uc.constraint_name WHERE uc.table_name = :1 AND uc.constraint_type IN ('P', 'U') ORDER BY uc.constraint_name, ucc.position",
    args: [table],
  });
  secs.push({
    key: "foreign_keys",
    q: "SELECT uc.constraint_name, USER AS from_schema, uc.table_name AS from_table, ucc.column_name, rc.owner AS ref_schema, rc.table_name AS ref_table, rcc.column_name AS ref_column FROM user_constraints uc JOIN user_cons_columns ucc ON ucc.constraint_name = uc.constraint_name JOIN all_constraints rc ON rc.owner = uc.r_owner AND rc.constraint_name = uc.r_constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = ucc.position WHERE uc.constraint_type = 'R' AND uc.table_name = :1 ORDER BY uc.constraint_name, ucc.position",
    args: [table],
  });
  secs.push({
    key: "referenced_by",
    q: "SELECT ac.constraint_name, ac.owner AS from_schema, ac.table_name AS from_table, acc.column_name, rcc.column_name AS ref_column FROM all_constraints rc JOIN all_constraints ac ON ac.r_owner = rc.owner AND ac.r_constraint_name = rc.constraint_name AND ac.constraint_type = 'R' JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position WHERE rc.table_name = :1 AND rc.owner = USER ORDER BY ac.owner, ac.constraint_name, acc.position",
    args: [table],
  });
  secs.push({
    key: "indexes",
    q: "SELECT ui.index_name, ui.uniqueness, uic.column_name, uic.column_position FROM user_indexes ui JOIN user_ind_columns uic ON uic.index_name = ui.index_name WHERE ui.table_name = :1 ORDER BY ui.index_name, uic.column_position",
    args: [table],
  });
  return secs;
}

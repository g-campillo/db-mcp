import { errorMessage } from "./errors.js";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Auditor } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import type { Connection } from "./connection.js";
import type { DbAdapter, QueryResult } from "./db/types.js";
import { authorize, permsToString, returnsRows, type Op } from "./permissions.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/**
 * Names the one database this server serves and its permitted operations,
 * appended to each tool description.
 */
export function connDescription(cfg: ResolvedConfig): string {
  let target = cfg.database !== "" ? cfg.database : cfg.oracleSid;
  if (target !== "") target = ` ${target}`;
  return `Connection: ${cfg.displayName}${target} (${permsToString(cfg.perms)}).`;
}

/** Opens the connection handle, mapping failure to a tool error result. */
async function getDb(conn: Connection): Promise<DbAdapter | CallToolResult> {
  try {
    return await conn.get();
  } catch (err) {
    return errorResult(
      `connection "${conn.cfg.name}" unavailable: ${errorMessage(err)}`,
    );
  }
}

function isToolResult(v: DbAdapter | CallToolResult): v is CallToolResult {
  return "content" in v;
}

/** Returns an error result unless the connection permits reads. */
function readGate(db: DbAdapter): CallToolResult | null {
  if (!db.cfg.perms.has("read")) {
    return errorResult(`read is not permitted on connection "${db.cfg.name}"`);
  }
  return null;
}

/** Executes fn, logs one audit record for the statement, and returns fn's result. */
async function runAudited(
  auditor: Auditor | null,
  db: DbAdapter,
  tool: string,
  sqlText: string,
  ops: Op[],
  fn: () => Promise<QueryResult>,
): Promise<CallToolResult> {
  const start = Date.now();
  let res: QueryResult | null = null;
  let error: string | undefined;
  try {
    res = await fn();
  } catch (err) {
    error = errorMessage(err);
  }
  auditor?.log({
    connection: db.cfg.name,
    tool,
    op: ops.join(","),
    sql: sqlText,
    rows: res?.row_count,
    rows_affected: res?.rows_affected,
    duration_ms: Date.now() - start,
    error,
  });
  if (error !== undefined) return errorResult(`query failed: ${error}`);
  return jsonResult(res);
}

/** Wraps a catalog call, mapping a driver error to a tool error result. */
async function catalogResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(`query failed: ${errorMessage(err)}`);
  }
}

/**
 * Wires the MCP tools onto the server for the one connection this process
 * serves. There is no connection parameter and no way to reach any other
 * database: the project's .mcp.json defines exactly this one.
 */
export function registerTools(
  server: McpServer,
  conn: Connection,
  auditor: Auditor | null,
): void {
  const summary = connDescription(conn.cfg);

  server.registerTool(
    "query",
    {
      description:
        "Execute a single SQL statement against the configured database. " +
        "Exactly one statement per call; DDL (CREATE/ALTER/DROP/TRUNCATE), MERGE and stored procedures are denied. " +
        summary,
      inputSchema: z.object({
        sql: z.string().describe("the single SQL statement to execute"),
      }),
    },
    async ({ sql }) => {
      if (sql.trim() === "") return errorResult("sql is required");
      const db = await getDb(conn);
      if (isToolResult(db)) return db;

      let ops: Op[];
      try {
        ops = authorize(sql, db.cfg);
      } catch (err) {
        return errorResult(errorMessage(err));
      }

      return runAudited(auditor, db, "query", sql, ops, () =>
        returnsRows(sql, db.cfg.sqlDriver) ? db.runRead(sql) : db.runWrite(sql),
      );
    },
  );

  server.registerTool(
    "list_tables",
    {
      description:
        "List base tables and views, optionally filtered by schema/owner. Requires read permission. " +
        summary,
      inputSchema: z.object({
        schema: z.string().optional().describe("optional schema or owner to filter by"),
      }),
    },
    async ({ schema }) => {
      const db = await getDb(conn);
      if (isToolResult(db)) return db;
      const denied = readGate(db);
      if (denied) return denied;
      return catalogResult(() => db.listTables(schema ?? ""));
    },
  );

  server.registerTool(
    "describe_table",
    {
      description:
        "Describe a table: columns, primary/unique constraints, foreign keys (both directions) and indexes. Requires read permission. " +
        summary,
      inputSchema: z.object({
        table: z.string().describe("the table name to describe"),
        schema: z.string().optional().describe("optional schema or owner of the table"),
      }),
    },
    async ({ table, schema }) => {
      if (table.trim() === "") return errorResult("table is required");
      const db = await getDb(conn);
      if (isToolResult(db)) return db;
      const denied = readGate(db);
      if (denied) return denied;
      return catalogResult(() => db.describeTable(table, schema ?? ""));
    },
  );

  server.registerTool(
    "search_schema",
    {
      description:
        "Find tables and columns by case-insensitive name substring (SQL LIKE wildcards % and _ pass through). Requires read permission. " +
        summary,
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "case-insensitive name substring to find; SQL LIKE wildcards (% and _) also work",
          ),
        type: z
          .string()
          .optional()
          .describe("restrict the search to 'table' or 'column'; omit to search both"),
        schema: z.string().optional().describe("optional schema or owner to filter by"),
      }),
    },
    async ({ pattern, type, schema }) => {
      if (pattern.trim() === "") return errorResult("pattern is required");
      const kind = type ?? "";
      if (kind !== "" && kind !== "table" && kind !== "column") {
        return errorResult('type must be "table" or "column" (or omitted for both)');
      }
      const db = await getDb(conn);
      if (isToolResult(db)) return db;
      const denied = readGate(db);
      if (denied) return denied;
      return catalogResult(() => db.searchSchema(pattern, kind, schema ?? ""));
    },
  );

  server.registerTool(
    "explain",
    {
      description:
        "Show the execution plan for a read-only SQL statement without executing it (EXPLAIN / EXPLAIN PLAN / SHOWPLAN_ALL). Requires read permission. " +
        summary,
      inputSchema: z.object({
        sql: z.string().describe("the read-only SQL statement to plan (it is not executed)"),
      }),
    },
    async ({ sql }) => {
      // Oracle rejects a trailing semicolon inside EXPLAIN PLAN FOR; trimming
      // is harmless on the other engines.
      const sqlText = sql.trim().replace(/[; \t\r\n]+$/, "");
      if (sqlText === "") return errorResult("sql is required");

      const db = await getDb(conn);
      if (isToolResult(db)) return db;
      const denied = readGate(db);
      if (denied) return denied;

      let ops: Op[];
      try {
        ops = authorize(sqlText, db.cfg);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      if (ops.length !== 1 || ops[0] !== "read") {
        return errorResult("explain only supports read statements");
      }

      return runAudited(auditor, db, "explain", sqlText, ops, () => db.explain(sqlText));
    },
  );
}

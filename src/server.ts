import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Auditor } from "./audit.js";
import { loadConfig, warnStaleGlobalConfig } from "./config.js";
import { Connection } from "./connection.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

/**
 * Serves MCP over stdio for the one database this process is configured for.
 *
 * Stdout carries the JSON-RPC stream, so nothing here may write to it. All
 * diagnostics go to stderr.
 */
export async function runServer(): Promise<void> {
  warnStaleGlobalConfig();

  const cfg = loadConfig();

  // The connection opens lazily on first use, so startup only fails on bad
  // config — never on a database that happens to be down.
  const conn = new Connection(cfg);
  const auditor = Auditor.open();

  // Built once, outside the factory: serveStdio calls the factory per
  // connection, and the pool and audit log are process-wide.
  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: "db-mcp", version: VERSION },
      { capabilities: { tools: {} } },
    );
    registerTools(server, conn, auditor);
    return server;
  });

  const shutdown = async () => {
    await handle.close().catch(() => {});
    await conn.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Serve until the client disconnects, i.e. until stdin closes.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
  await handle.close().catch(() => {});
  await conn.close();
}

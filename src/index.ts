/**
 * Entry point.
 *
 * The MCP client launches db-mcp with **no arguments**; any invocation with
 * arguments is the credential-management CLI. The two paths are loaded
 * dynamically and never both: in server mode stdout carries the JSON-RPC
 * stream, so the CLI's logging and banner must not even be imported.
 */

import { errorMessage } from "./errors.js";

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    const { runServer } = await import("./server.js");
    await runServer();
    return;
  }
  const { runCli } = await import("./cli/index.js");
  await runCli(process.argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`db-mcp: ${errorMessage(err)}\n`);
  process.exit(1);
});

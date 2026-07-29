/**
 * Entry point.
 *
 * An MCP client launches db-mcp with **no arguments** and a piped stdin, and
 * that is the one invocation that serves MCP. Everything else is for a person:
 * arguments run the CLI, and a bare invocation from a terminal — where stdin is
 * a TTY, which a client's spawn never is — prints the overview rather than
 * sitting mute on a JSON-RPC stream nobody is speaking. `db-mcp serve` forces
 * server mode for the rare case of driving it by hand.
 *
 * The two paths are loaded dynamically and never both: in server mode stdout
 * carries JSON-RPC, so the CLI's logging must not even be imported.
 */

import { errorMessage } from "./errors.js";

async function main(): Promise<void> {
  if (process.argv.length <= 2 && !process.stdin.isTTY) {
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

import { errorMessage } from "../errors.js";
import { Command } from "commander";
import { VERSION } from "../version.js";
import { epilogue, HELP_STYLES } from "./help.js";
import {
  deleteStored,
  listStored,
  renameStored,
  storeConnection,
  testEnvironment,
  testStored,
} from "./keychain.js";
import * as log from "./logger.js";
import { closePrompts } from "./prompt.js";

/**
 * The command-line side of db-mcp: credential management, connection tests and
 * the overview screen. Reached whenever the process is not serving MCP, which
 * an MCP client's bare piped launch never is — so nothing here is imported on
 * the hot path where stdout carries JSON-RPC.
 */
export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  log.banner(VERSION);

  // Commander treats "no command given" as a usage error: help on stderr,
  // exit 1. Typing `db-mcp` to see what it does is not an error.
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(argv);
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("db-mcp")
    .description(
      "MCP server that runs SQL against PostgreSQL, SQL Server or Oracle —\n" +
        "one process, one database, with per-project permission gating.",
    )
    .version(VERSION)
    .configureHelp(HELP_STYLES)
    .showHelpAfterError("(run 'db-mcp' with no arguments for the full command list)")
    .addHelpText("after", () => epilogue(program));

  program
    .command("test")
    .description("Connect using the DB_* variables in the environment")
    .action(() => run(testEnvironment));

  program
    .command("serve")
    .description("Serve MCP over stdio — what an MCP client runs")
    .action(() =>
      run(async () => {
        const { runServer } = await import("../server.js");
        await runServer();
      }),
    );

  const keychain = program
    .command("keychain")
    .description("Manage connection secrets in the macOS Keychain");

  keychain
    .command("add [name]")
    .description("Store a new connection's DSN under db-mcp/<name>")
    .action((name?: string) => run(() => storeConnection(name, false)));

  keychain
    .command("update [name]")
    .description("Re-enter an existing connection's credentials (rotation)")
    .action((name?: string) => run(() => storeConnection(name, true)));

  keychain
    .command("list")
    .description("List stored connection names")
    .action(() => run(async () => listStored()));

  keychain
    .command("rename [old] [new]")
    .description("Rename a stored connection, e.g. one you typed wrong")
    .action((oldName?: string, newName?: string) =>
      run(() => renameStored(oldName ?? "", newName ?? "")),
    );

  keychain
    .command("test [name]")
    .description("Connect using a stored connection and report the result")
    .action((name?: string) => run(() => testStored(name)));

  keychain
    .command("delete [name]")
    .description("Remove a stored connection")
    .action((name?: string) => run(() => deleteStored(name)));

  return program;
}

/**
 * Runs an action, turning a thrown error into a clean one-line failure. The
 * shared readline interface holds stdin open, so it is always released —
 * otherwise a command that prompted would never exit.
 */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(errorMessage(err));
    closePrompts();
    process.exit(1);
  }
  closePrompts();
}

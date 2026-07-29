import { errorMessage } from "../errors.js";
import { Command } from "commander";
import { VERSION } from "../version.js";
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
 * The credential-management CLI. Only reached when db-mcp is invoked with
 * arguments — a bare invocation is the MCP server, whose stdout must stay
 * clean, so nothing in this module is imported in that path.
 */
export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("db-mcp")
    .description(
      "MCP server for PostgreSQL, SQL Server and Oracle.\n" +
        "Run with no arguments to serve MCP over stdio; the commands below manage credentials.",
    )
    .version(VERSION)
    .showHelpAfterError();

  program
    .command("test")
    .description("Connect using the DB_* variables in the environment and report the result")
    .action(() => run(testEnvironment));

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
    .description("Rename a stored connection, e.g. after typing the wrong name")
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

  log.banner(VERSION);
  await program.parseAsync(argv);
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

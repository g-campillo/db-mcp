import chalk from "chalk";
import type { Command } from "commander";

/**
 * The overview screen: what a bare `db-mcp` in a terminal, `db-mcp --help` and
 * `db-mcp help` all print.
 *
 * It exists to answer "what can I run, and how do I wire this up?" without
 * anyone opening the README. Commander generates the command list from the
 * commands actually registered, so that half can never drift; everything here
 * is the surrounding context commander cannot know about. Blocks are written
 * without leading or trailing blank lines and joined by exactly one.
 */

/** Light styling for commander's own generated sections, to match the logger. */
export const HELP_STYLES = {
  styleTitle: (s: string) => chalk.bold(s),
  styleSubcommandTerm: (s: string) => chalk.cyan(s),
  styleOptionTerm: (s: string) => chalk.cyan(s),
};

/**
 * Expands command groups. Commander's top-level list names `keychain` but not
 * what is inside it, and the contents are exactly what people forget.
 */
function nestedCommands(program: Command): string {
  const helper = program.createHelp();
  const blocks: string[] = [];
  for (const group of program.commands) {
    if (group.commands.length === 0) continue;
    const terms = group.commands.map((c) => helper.subcommandTerm(c));
    const width = Math.max(...terms.map((t) => t.length));
    const rows = group.commands.map(
      (c, i) => `  ${chalk.cyan(terms[i]!.padEnd(width))}  ${c.description()}`,
    );
    const title = group.name().charAt(0).toUpperCase() + group.name().slice(1);
    blocks.push([chalk.bold(`${title} commands:`), ...rows].join("\n"));
  }
  return blocks.join("\n\n");
}

const GETTING_STARTED = `${chalk.bold("Getting started:")}
  1  db-mcp keychain add            store a connection in the macOS Keychain
  2  paste the printed snippet into the project's .mcp.json
  3  db-mcp keychain test <name>    confirm the stored connection works`;

const MCP_JSON = `${chalk.bold("Project .mcp.json — the env block is the whole configuration:")}
  {
    "mcpServers": {
      "db": {
        "command": "db-mcp",
        "env": {
          "DB_DRIVER": "oracle",
          "DB_PERMISSIONS": "read,create,update,delete",
          "DB_DSN_CMD": "security find-generic-password -s db-mcp/<name> -w"
        }
      }
    }
  }`;

const ENVIRONMENT = `${chalk.bold("Environment:")}
  ${chalk.cyan("DB_DRIVER")}                   postgres | sqlserver | oracle — required
  ${chalk.cyan("DB_DSN_CMD")}                  command whose stdout is the full DSN
  ${chalk.cyan("DB_DSN")}                      full DSN inline (prefer DB_DSN_CMD)
  ${chalk.cyan("DB_PERMISSIONS")}              read,create,update,delete (default: read)
  ${chalk.cyan("DB_MAX_ROWS")}                 rows fetched per query (default: 500)
  ${chalk.cyan("DB_QUERY_TIMEOUT")}            per-query timeout, e.g. 1m30s (default: 30s)
  ${chalk.cyan("DB_ALLOW_UNFILTERED_WRITES")}  allow UPDATE/DELETE with no WHERE (default: false)
  ${chalk.cyan("DB_AUDIT_PATH")}               audit log (default: <config>/db-mcp/audit.jsonl)
  ${chalk.cyan("DB_AUDIT_DISABLED")}           set true to turn auditing off

  Instead of a DSN, supply the parts: DB_HOST, DB_PORT, DB_USER,
  DB_PASSWORD | DB_PASSWORD_CMD, DB_NAME (Oracle: service) | DB_ORACLE_SID.`;

const DSN_FORMATS = `${chalk.bold("DSN formats stored in the Keychain:")}
  postgres     postgres://user:pass@host:5432/db
  sqlserver    sqlserver://user:pass@host:1433?database=db
  oracle       oracle://user:pass@host:1521/service  (or /?SID=ORCL)`;

const TOOLS = `${chalk.bold("Tools served to the agent:")}
  query   list_tables   describe_table   search_schema   explain`;

const FOOTER = chalk.dim(
  `db-mcp <command> --help shows one command's options. Typed in a terminal with
no arguments, db-mcp prints this screen; launched by an MCP client (stdin is a
pipe) it serves MCP over stdio. 'db-mcp serve' forces server mode by hand.`,
);

/**
 * The whole epilogue, appended below commander's generated sections. Commander
 * emits it as one block with no separator of its own, hence the leading blank.
 */
export function epilogue(program: Command): string {
  const blocks = [
    nestedCommands(program),
    GETTING_STARTED,
    MCP_JSON,
    ENVIRONMENT,
    DSN_FORMATS,
    TOOLS,
    FOOTER,
  ];
  return `\n${blocks.join("\n\n")}`;
}

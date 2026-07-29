import chalk from "chalk";

const INDENT = "  ";

export function info(msg: string): void {
  console.log(`${INDENT}${chalk.cyan("i")} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${INDENT}${chalk.green("✔")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${INDENT}${chalk.yellow("!")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${INDENT}${chalk.red("✘")} ${msg}`);
}

export function dim(msg: string): void {
  console.log(`${INDENT}${chalk.dim(msg)}`);
}

export function plain(msg = ""): void {
  console.log(msg);
}

/**
 * Written to stderr, not stdout: `db-mcp serve` reaches the CLI too, and there
 * stdout is the JSON-RPC stream. A terminal shows both streams either way.
 */
export function banner(version: string): void {
  console.error(`\n${INDENT}${chalk.bold.cyan(`db-mcp v${version}`)}\n`);
}

/** A fenced block of config for the user to copy, e.g. an .mcp.json snippet. */
export function snippet(lines: string[]): void {
  for (const line of lines) console.log(`${INDENT}${chalk.dim("│")} ${line}`);
}

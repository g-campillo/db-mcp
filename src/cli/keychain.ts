import { loadConfig } from "../config.js";
import { DRIVER_CHOICES, resolveDriver } from "../drivers.js";
import { buildDsn, driverFromDsn } from "../dsn.js";
import {
  deleteConnection,
  listConnections,
  readConnection,
  renameConnection,
  validConnName,
  writeConnection,
} from "../keychain.js";
import * as log from "./logger.js";
import { probeConfig, probeConnection, type ProbeResult } from "./probe.js";
import {
  promptChoice,
  promptPassword,
  promptPort,
  promptRequired,
  promptText,
  promptYesNo,
} from "./prompt.js";

/** `keychain add` / `keychain update`: prompt for every field, then store. */
export async function storeConnection(
  presetName: string | undefined,
  isUpdate: boolean,
): Promise<void> {
  let name = presetName;
  if (!name) {
    name = isUpdate ? await pickConnection() : await promptRequired("Connection name (stored as db-mcp/<name>)");
  }
  if (!validConnName(name)) {
    throw new Error("invalid name: use letters, digits, dot, dash or underscore only");
  }
  if (!isUpdate && readConnection(name) !== null) {
    throw new Error(`"${name}" already exists — use: db-mcp keychain update ${name}`);
  }

  const driver = await promptChoice("Database type", [...DRIVER_CHOICES]);
  const info = resolveDriver(driver);
  if (!info) throw new Error("unknown driver");

  const host = await promptRequired("Host");
  const port = await promptPort(info.defaultPort);
  const user = await promptRequired("User");
  const password = await promptPassword("Password");

  let database = "";
  let oracleSid = "";
  if (info.sqlDriver === "oracle") {
    const service = await promptText("Oracle service name (leave blank to connect by SID)");
    if (service !== "") database = service;
    else oracleSid = await promptRequired("Oracle SID");
  } else {
    database = await promptRequired("Database");
  }

  const dsn = buildDsn(info.sqlDriver, { host, port, user, password, database, oracleSid });

  // Catch bad credentials here rather than the next time an agent runs a query.
  if (await promptYesNo("Test this connection before storing?", true)) {
    const result = await probeConnection(probeConfig(info), dsn);
    reportProbe(result);
    if (!result.ok && !(await promptYesNo("Store it anyway?", false))) {
      log.warn("Nothing was stored.");
      return;
    }
  }

  writeConnection(name, dsn);
  // Verify the readback without ever printing the secret.
  if (readConnection(name) !== dsn) {
    log.warn("stored, but readback verification failed");
  }

  const perms = await promptText(
    "Permissions for the .mcp.json snippet (not stored in Keychain)",
    "read",
  );

  log.plain();
  log.success(`${isUpdate ? "Updated" : "Stored"} db-mcp/${name} in the login Keychain.`);
  printSnippet(driver, perms, name);
}

/** `keychain list` */
export function listStored(): void {
  const names = listConnections();
  if (names.length === 0) {
    log.info("no db-mcp connections stored (add one with: db-mcp keychain add)");
    return;
  }
  for (const n of names) log.plain(`  ${n}`);
}

/** `keychain rename <old> <new>` */
export async function renameStored(from: string, to: string): Promise<void> {
  const oldName = from || (await pickConnection());
  const newName = to || (await promptRequired("New name"));
  renameConnection(oldName, newName);
  log.success(`Renamed db-mcp/${oldName} to db-mcp/${newName}.`);
  log.plain();
  log.info("Update the project's .mcp.json to point at the new name:");
  log.snippet([`"DB_DSN_CMD": "security find-generic-password -s db-mcp/${newName} -w"`]);
}

/** `keychain delete <name>` */
export async function deleteStored(name: string | undefined): Promise<void> {
  const target = name || (await pickConnection());
  if (readConnection(target) === null) {
    throw new Error(`no stored connection named "${target}"`);
  }
  if (!(await promptYesNo(`Delete db-mcp/${target}?`, false))) {
    log.warn("Nothing was deleted.");
    return;
  }
  deleteConnection(target);
  log.success(`Deleted db-mcp/${target}.`);
}

/** `keychain test <name>` — probe a stored connection. */
export async function testStored(name: string | undefined): Promise<void> {
  const target = name || (await pickConnection());
  const dsn = readConnection(target);
  if (dsn === null) {
    throw new Error(`no stored connection named "${target}" (list them with: db-mcp keychain list)`);
  }
  // The stored DSN names its own driver in the URL scheme, so there is nothing
  // to ask: postgres:// | sqlserver:// | oracle://.
  const info =
    driverFromDsn(dsn) ??
    resolveDriver(await promptChoice("Database type", [...DRIVER_CHOICES]));
  if (!info) throw new Error("unknown driver");

  const result = await probeConnection(probeConfig(info), dsn);
  reportProbe(result);
  if (!result.ok) process.exitCode = 1;
}

/**
 * `db-mcp test` — probe whatever DB_* variables are in the environment, so a
 * project's .mcp.json can be debugged directly.
 */
export async function testEnvironment(): Promise<void> {
  const cfg = loadConfig();
  const { Connection } = await import("../connection.js");
  const dsn = await new Connection(cfg).resolveDsn();
  const result = await probeConnection(cfg, dsn);
  reportProbe(result);
  if (!result.ok) process.exitCode = 1;
}

function reportProbe(r: ProbeResult): void {
  if (r.ok) {
    log.success(`Connected to ${r.driver} ${r.target} in ${r.elapsedMs}ms`);
    if (r.version) log.dim(r.version);
    return;
  }
  log.error(`Could not connect to ${r.driver} ${r.target} (${r.elapsedMs}ms)`);
  if (r.error) log.dim(r.error);
}

/** Lists the stored connections and returns the one the user picks. */
async function pickConnection(): Promise<string> {
  const names = listConnections();
  if (names.length === 0) {
    throw new Error("no db-mcp connections stored yet (add one with: db-mcp keychain add)");
  }
  log.info("Stored connections:");
  names.forEach((n, i) => log.plain(`    ${i + 1}) ${n}`));
  const sel = await promptRequired("Select a connection (number or name)");
  const n = Number(sel);
  if (Number.isInteger(n) && n >= 1 && n <= names.length) return names[n - 1]!;
  if (names.includes(sel)) return sel;
  throw new Error("no such connection");
}

function printSnippet(driver: string, perms: string, name: string): void {
  log.plain();
  log.info("Add this to the project's .mcp.json:");
  log.snippet([
    `"env": {`,
    `  "DB_DRIVER": "${driver}",`,
    `  "DB_PERMISSIONS": "${perms}",`,
    `  "DB_DSN_CMD": "security find-generic-password -s db-mcp/${name} -w"`,
    `}`,
  ]);
}

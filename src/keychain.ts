import { execFileSync } from "node:child_process";

/**
 * Connection secrets in the macOS login Keychain. One item per connection:
 * service `db-mcp/<name>`, account `<name>`, and the full DSN as the secret,
 * which DB_DSN_CMD reads back at runtime.
 *
 * Only the DSN lives here — driver and permissions stay in the project's
 * .mcp.json, so the Keychain holds the secret and nothing else.
 */

const SERVICE_PREFIX = "db-mcp";

const CONN_NAME = /^[A-Za-z0-9._-]+$/;

/** Connection names are embedded in the service string, so keep them boring. */
export function validConnName(s: string): boolean {
  return CONN_NAME.test(s);
}

function service(name: string): string {
  if (!validConnName(name)) {
    throw new Error(
      `invalid name "${name}": use letters, digits, dot, dash or underscore only`,
    );
  }
  return `${SERVICE_PREFIX}/${name}`;
}

/** Reads the stored DSN, or null when the item does not exist. */
export function readConnection(name: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service(name), "-w"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/[\r\n]+$/, "");
  } catch {
    return null;
  }
}

/**
 * Writes (or updates, via -U) the DSN. The account attribute is the connection
 * name so it stays stable across updates.
 *
 * The secret is passed in argv, which is briefly visible to `ps` on this
 * machine — the same trade-off the Go build accepted for local dev credentials.
 */
export function writeConnection(name: string, dsn: string): void {
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", service(name), "-a", name, "-w", dsn],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`security add-generic-password: ${stderr || String(err)}`);
  }
}

/** Removes a stored connection. */
export function deleteConnection(name: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", service(name)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`security delete-generic-password: ${stderr || String(err)}`);
  }
}

/**
 * Enumerates stored db-mcp/* connection names. Reads only item attributes (no
 * -d), so it never triggers a Keychain access prompt.
 */
export function listConnections(): string[] {
  let dump = "";
  try {
    dump = execFileSync("security", ["dump-keychain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return parseKeychainConns(dump);
}

const SVCE_RE = /"svce"<blob>="db-mcp\/([^"]+)"/g;

/** Extracts db-mcp/<name> service names from `security dump-keychain` output. */
export function parseKeychainConns(dump: string): string[] {
  const names = new Set<string>();
  for (const m of dump.matchAll(SVCE_RE)) {
    const name = m[1]!;
    if (validConnName(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Moves a stored connection to a new name. `security` has no rename, so this
 * copies the secret across and then removes the original — and verifies the
 * copy landed before deleting anything.
 */
export function renameConnection(from: string, to: string): void {
  if (!validConnName(to)) {
    throw new Error(`invalid name "${to}": use letters, digits, dot, dash or underscore only`);
  }
  if (from === to) throw new Error("the new name is the same as the old one");

  const dsn = readConnection(from);
  if (dsn === null) {
    throw new Error(`no stored connection named "${from}" (list them with: db-mcp keychain list)`);
  }
  if (readConnection(to) !== null) {
    throw new Error(`"${to}" already exists — pick another name or delete it first`);
  }

  writeConnection(to, dsn);
  // Only drop the original once the copy reads back intact.
  if (readConnection(to) !== dsn) {
    throw new Error(`copy to "${to}" could not be verified; the original was left in place`);
  }
  deleteConnection(from);
}

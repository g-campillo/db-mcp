/**
 * Driver identity: the user-facing name in DB_DRIVER, the internal driver key
 * used to branch catalog SQL and placeholder syntax, and the default port.
 */

/** Internal driver key. Kept as the Go names so ported SQL reads identically. */
export type SqlDriver = "pgx" | "sqlserver" | "oracle";

export interface DriverInfo {
  sqlDriver: SqlDriver;
  /** User-facing label, e.g. in error messages and tool descriptions. */
  displayName: string;
  defaultPort: number;
}

/**
 * Maps a user-facing driver name/alias to its internal key, display label and
 * default port. Returns null for an unknown driver.
 */
export function resolveDriver(driver: string): DriverInfo | null {
  switch (driver.trim().toLowerCase()) {
    case "postgres":
    case "postgresql":
      return { sqlDriver: "pgx", displayName: "postgres", defaultPort: 5432 };
    case "sqlserver":
    case "mssql":
      return { sqlDriver: "sqlserver", displayName: "sqlserver", defaultPort: 1433 };
    case "oracle":
      return { sqlDriver: "oracle", displayName: "oracle", defaultPort: 1521 };
  }
  return null;
}

/** The driver names accepted in DB_DRIVER and offered by the keychain CLI. */
export const DRIVER_CHOICES = ["postgres", "sqlserver", "oracle"] as const;

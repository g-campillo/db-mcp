import type { ResolvedConfig } from "../config.js";
import { MssqlAdapter } from "./mssql.js";
import { OracleAdapter } from "./oracle.js";
import { PostgresAdapter } from "./postgres.js";
import type { DbAdapter } from "./types.js";

/** Opens a pool for the configured driver and verifies it can connect. */
export async function openAdapter(cfg: ResolvedConfig, dsn: string): Promise<DbAdapter> {
  switch (cfg.sqlDriver) {
    case "pgx":
      return PostgresAdapter.open(cfg, dsn);
    case "sqlserver":
      return MssqlAdapter.open(cfg, dsn);
    case "oracle":
      return OracleAdapter.open(cfg, dsn);
  }
}

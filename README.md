# db-mcp

A single MCP server that runs SQL against **PostgreSQL, SQL Server, or Oracle**,
where the CRUD operations the agent may perform are controlled per config.

- One binary, three databases (pure-Go drivers — **no Oracle Instant Client, no ODBC**).
- Permissions (`read` / `create` / `update` / `delete`) set in `.mcp.json`, **read-only by default**.
- Each server entry has its own permissions, so a read-only `db-prod` can sit
  next to a full-CRUD `db-dev`.

## Build

Requires Go 1.23+ (the toolchain auto-fetches a newer one if a dependency needs it).

```sh
go mod tidy        # resolves and pins dependency versions
go build -o db-mcp .
```

This produces a self-contained `db-mcp` binary.

## Configure (`.mcp.json`)

One entry per database. Connection details are discrete fields (no DSN to memorise);
the port defaults per driver (5432 / 1433 / 1521).

```jsonc
{
  "mcpServers": {
    "db-prod": {
      "command": "/abs/path/to/db-mcp",
      "env": {
        "DB_DRIVER": "postgres",
        "DB_HOST": "db.internal",
        "DB_USER": "app_ro",
        "DB_PASSWORD": "secret",
        "DB_NAME": "appdb",
        "DB_PERMISSIONS": "read"
      }
    }
  }
}
```

### Environment variables

| Var | Meaning | Default |
|-----|---------|---------|
| `DB_DRIVER` | `postgres` \| `sqlserver` \| `oracle` | required |
| `DB_HOST` | host | required |
| `DB_PORT` | port | 5432 / 1433 / 1521 |
| `DB_USER` | user | required |
| `DB_PASSWORD` | password | required |
| `DB_NAME` | database name (**Oracle: service name**) | required* |
| `DB_ORACLE_SID` | Oracle only: connect by SID instead of service name | — |
| `DB_PERMISSIONS` | comma list of `read,create,update,delete` | `read` |
| `DB_MAX_ROWS` | max rows returned per query | `500` |
| `DB_QUERY_TIMEOUT` | per-query timeout (Go duration) | `30s` |

\* For Oracle, supply exactly one of `DB_NAME` (service name) **or** `DB_ORACLE_SID`.

### Per-driver connection examples

```jsonc
// SQL Server
"env": { "DB_DRIVER": "sqlserver", "DB_HOST": "win-sql", "DB_USER": "sa",
         "DB_PASSWORD": "...", "DB_NAME": "Northwind", "DB_PERMISSIONS": "read,update" }

// Oracle by service name
"env": { "DB_DRIVER": "oracle", "DB_HOST": "ora-host", "DB_USER": "scott",
         "DB_PASSWORD": "...", "DB_NAME": "ORCLPDB1" }

// Oracle by SID
"env": { "DB_DRIVER": "oracle", "DB_HOST": "ora-host", "DB_USER": "scott",
         "DB_PASSWORD": "...", "DB_ORACLE_SID": "ORCL" }
```

## Tools

- **`query`** — run one SQL statement. Reads return JSON rows (capped at
  `DB_MAX_ROWS`); writes return `rows_affected`.
- **`list_tables`** `{ schema? }` — list base tables (read permission only).
- **`describe_table`** `{ table, schema? }` — column names and types (read permission only).

## How permissions are enforced

Each statement is classified by its leading verb — `SELECT`→read, `INSERT`→create,
`UPDATE`→update, `DELETE`→delete — and rejected if that operation isn't in
`DB_PERMISSIONS`. Comments and string/identifier literals are stripped first, so a
keyword or semicolon hidden inside one can't slip through. **Only one statement per
call** is allowed, and anything that isn't plain CRUD — DDL (`CREATE`/`ALTER`/`DROP`/
`TRUNCATE`), `MERGE`, `SELECT … INTO`, stored-proc `EXEC`/`CALL` — is always denied.

### Use a least-privilege DB user (important)

The permission gate is a guardrail, not a sandbox. The real boundary is the
database's own privileges — connect with an account that only holds the grants you
intend, so even a missed edge case can't do harm:

```sql
-- PostgreSQL, read-only
CREATE USER app_ro WITH PASSWORD '...';
GRANT CONNECT ON DATABASE appdb TO app_ro;
GRANT USAGE ON SCHEMA public TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;
```

## Limitations (v1)

- Supports PostgreSQL, SQL Server, Oracle. (MySQL/SQLite are easy to add — both are
  `database/sql` drivers.)
- DDL, `TRUNCATE`, `MERGE`, and stored procedures are deliberately denied.
- The agent inlines literal values in SQL (no separate bound-parameter argument yet).
- Oracle connects by host+port with service name or SID (no wallets / TNS aliases yet).
- One database per process — run multiple `.mcp.json` entries for multiple databases.

## Test

```sh
go test ./...   # covers the permission classifier (the security-critical core)
```

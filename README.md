# db-mcp

A single MCP server that runs SQL against **PostgreSQL, SQL Server, or Oracle**,
where the CRUD operations the agent may perform are controlled per connection.

- One binary, three databases (pure-Go drivers — **no Oracle Instant Client, no ODBC**).
- **One process serves many named connections**, each with its own permissions
  (`read` / `create` / `update` / `delete`, **read-only by default**), row caps and timeouts.
- Connections open lazily on first use: one database being down never blocks the others.
- Every agent-authored statement is **audit-logged** to JSONL.

## Build

Requires Go 1.23+ (the toolchain auto-fetches a newer one if a dependency needs it).

```sh
make install       # builds the self-contained ./db-mcp binary
```

Other targets: `make test` (vet + unit tests), `make smoke` (builds the
integration harness), `make clean`.

## Configure

Connections live in a JSON config file. Default path:
`os.UserConfigDir()/db-mcp/config.json` — on macOS that is
`~/Library/Application Support/db-mcp/config.json` — or point `DB_MCP_CONFIG`
anywhere. The server warns at startup if the file is group/other-readable
(`chmod 600` it).

```jsonc
{
  "connections": [
    {
      "name": "pg-prod",
      "description": "Prod Postgres, read-only",
      "driver": "postgres",            // postgres | sqlserver | oracle
      "host": "db.internal",
      "port": 5432,                    // optional; defaults 5432 / 1433 / 1521
      "user": "app_ro",
      "password": "secret",
      "database": "appdb",
      "permissions": "read"            // omit for read-only
    },
    {
      "name": "ora-dev",
      "driver": "oracle",
      "host": "ora-host",
      "user": "scott",
      "password_cmd": "security find-generic-password -s ora-dev -w",
      "oracle_sid": "ORCL",            // or "database": "<service name>" — exactly one
      "permissions": "read,create,update,delete",
      "allow_unfiltered_writes": true  // permit UPDATE/DELETE without WHERE
    }
  ],
  "audit_path": "",                    // default: <UserConfigDir>/db-mcp/audit.jsonl
  "audit_disabled": false
}
```

Per-connection fields and defaults:

| Field | Meaning | Default |
|-------|---------|---------|
| `name` | unique connection name, used in tool calls | required |
| `driver` | `postgres` \| `sqlserver` \| `oracle` | required |
| `host`, `user` | connection basics | required |
| `port` | port | 5432 / 1433 / 1521 |
| `password` | inline password | — |
| `password_cmd` | shell command whose stdout is the password (e.g. macOS Keychain via `security find-generic-password -w`); mutually exclusive with `password` | — |
| `database` | database name (**Oracle: service name**) | required* |
| `oracle_sid` | Oracle only: connect by SID instead of service name | — |
| `permissions` | comma list of `read,create,update,delete` | `read` |
| `max_rows` | max rows returned per query | `500` |
| `query_timeout` | per-query timeout (Go duration) | `30s` |
| `allow_unfiltered_writes` | allow `UPDATE`/`DELETE` with no top-level `WHERE` | `false` |
| `max_cell_bytes` | per-cell byte cap, `-1` disables | `8192` |
| `max_result_bytes` | approximate whole-result byte cap, `0` disables | `0` |

\* For Oracle, supply exactly one of `database` (service name) **or** `oracle_sid`.

The `.mcp.json` entry shrinks to just the binary (plus `DB_MCP_CONFIG` if not
using the default path):

```jsonc
{
  "mcpServers": {
    "db": { "command": "/abs/path/to/db-mcp" }
  }
}
```

### Legacy env mode (backward compatibility)

With no config file present, the v1 `DB_*` environment variables still work and
become a single connection named `default`: `DB_DRIVER`, `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_ORACLE_SID`, `DB_PERMISSIONS`,
`DB_MAX_ROWS`, `DB_QUERY_TIMEOUT`. A config file, when found, always wins.

## Tools

Every tool takes an optional `connection` name — omit it when exactly one
connection is configured. Tool descriptions enumerate the connections and
their permissions so the agent knows what is allowed where.

- **`query`** `{ sql, connection? }` — run one SQL statement. Reads return JSON
  rows (capped at `max_rows`); writes return `rows_affected`.
- **`list_connections`** — names, engines and permitted operations of all
  configured connections.
- **`list_tables`** `{ schema?, connection? }` — tables **and views**, with a
  `table_type` per row.
- **`describe_table`** `{ table, schema?, connection? }` — columns, primary/unique
  constraints, foreign keys (both directions) and indexes.
- **`search_schema`** `{ pattern, type?, schema?, connection? }` — find tables
  and/or columns by case-insensitive name substring (`type`: `table` | `column`;
  SQL LIKE wildcards pass through).
- **`explain`** `{ sql, connection? }` — the engine's plan for a read-only
  statement without executing it (`EXPLAIN` / `EXPLAIN PLAN FOR` + `DBMS_XPLAN` /
  `SET SHOWPLAN_ALL`). Oracle needs `PLAN_TABLE` available to the user.

The introspection tools require `read` permission on the target connection.

## Audit log

Every statement the agent authors (the `query` and `explain` tools) is appended
to a JSONL audit file — reads and writes, successes and failures — with
timestamp, connection, classified operation, SQL text, row counts and duration.
Fixed catalog queries from the introspection tools and statements denied by the
permission gate (never executed) are not logged. No rotation is built in; the
file is plain JSONL for external tools to rotate.

## How permissions are enforced

Each statement is classified and rejected unless every operation it performs is
in the connection's `permissions`:

- Comments, string/identifier literals, and (on Postgres) `$tag$…$tag$`
  dollar-quoted bodies are blanked first, so a keyword or semicolon hidden
  inside one can't slip through. **Only one statement per call.**
- The leading verb maps to the operation: `SELECT`→read, `INSERT`→create,
  `UPDATE`→update, `DELETE`→delete.
- `WITH` statements are walked structurally: each CTE body and the main
  statement are classified separately, so a data-modifying CTE
  (`WITH x AS (DELETE … RETURNING …) SELECT …`) needs both `read` and `delete`,
  while write verbs appearing as identifiers or in `FOR UPDATE` row locks do
  not trip the gate.
- `UPDATE`/`DELETE` with no top-level `WHERE` clause is denied unless the
  connection sets `allow_unfiltered_writes` (a `WHERE` inside a subquery does
  not count).
- Anything that isn't plain CRUD — DDL (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`),
  `MERGE`, `SELECT … INTO`, stored-proc `EXEC`/`CALL` — is always denied,
  including as the main statement after a CTE.

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

## Limitations

- Supports PostgreSQL, SQL Server, Oracle. (MySQL/SQLite are easy to add — both are
  `database/sql` drivers.)
- DDL, `TRUNCATE`, `MERGE`, and stored procedures are deliberately denied.
- `INSERT … ON CONFLICT DO UPDATE` classifies as create only (upsert semantics
  are a future scope call).
- The agent inlines literal values in SQL (no separate bound-parameter argument yet).
- Oracle connects by host+port with service name or SID (no wallets / TNS aliases
  yet); `list_tables` excludes materialized views.
- The audit log has no built-in rotation and is not fsync'd per line.

## Test

```sh
go test ./...   # classifier (security-critical core), config parsing, cell caps
```

### Smoke harness

`cmd/smoke` launches the built binary over stdio as a real MCP client and
exercises every tool against a live database:

```sh
go build -o db-mcp . && go build -o smoke ./cmd/smoke
./smoke ./db-mcp [configfile] [connection]
```

Without a `configfile` it inherits `DB_*` env vars (the legacy-mode test).
Prerequisites: a `widgets(id int primary key, name text)` table and a
connection granting `read,create` but **not** delete — the harness asserts the
delete/drop/unfiltered-delete steps are denied.

# db-mcp

A single MCP server that runs SQL against **PostgreSQL, SQL Server, or Oracle**,
where the CRUD operations the agent may perform are controlled per project.

- One command, three databases (pure-JavaScript drivers — **no Oracle Instant
  Client, no ODBC**; node-oracledb runs in Thin mode).
- **One process serves exactly one database**, defined entirely by the project's
  own `.mcp.json`. There is no way for the agent to reach any other database.
- Permissions (`read` / `create` / `update` / `delete`, **read-only by default**),
  a row cap and a query timeout are configured per project.
- The connection opens lazily on first use — a database being down never blocks startup.
- Every agent-authored statement is **audit-logged** to JSONL.

## Why one database per process

An earlier version loaded a machine-global config file listing every connection,
so any project that ran the binary could enumerate and query **all** of them —
the project's `.mcp.json` scoped nothing. That ambient authority is gone: each
`.mcp.json` defines its own single connection, there is no `connection`
parameter and no `list_connections` tool, so an agent is confined to the one
database its project granted it. Store the secret in the macOS Keychain, not on
disk.

## Install

Requires Node 20+.

```sh
npm install
npm run build
npm link          # puts db-mcp on your PATH, so .mcp.json can just say "db-mcp"
```

`npm link` symlinks this checkout, so after changing code you only need
`npm run build` — the linked command picks it up.

Other scripts: `npm test` (unit tests), `npm run typecheck`, `npm run dev`
(run from source without building), `npm run smoke` (integration harness).

## Configure

Everything comes from the `env` block of the project's local `.mcp.json`. The
recommended setup keeps **no secret on disk**: the whole connection string lives
in the macOS Keychain and `DB_DSN_CMD` pulls it out.

```jsonc
{
  "mcpServers": {
    "db": {
      "command": "db-mcp",                     // on PATH after `npm link`
      "env": {
        "DB_DRIVER": "oracle",                 // postgres | sqlserver | oracle
        "DB_PERMISSIONS": "read,create,update,delete",
        "DB_DSN_CMD": "security find-generic-password -s db-mcp/navy-dev -w"
      }
    }
  }
}
```

## Managing credentials

The built-in CLI stores connection strings in the macOS Keychain. `db-mcp` with
**no arguments** is the MCP server; anything else is the CLI.

```sh
db-mcp keychain add                 # prompts, offers to test, stores db-mcp/<name>
db-mcp keychain update              # pick an existing connection, re-enter creds
db-mcp keychain list                # list stored connection names
db-mcp keychain rename old new      # fix a name you typed wrong
db-mcp keychain test <name>         # connect using a stored connection
db-mcp keychain delete <name>       # remove a stored connection
db-mcp test                         # connect using the DB_* vars in the environment
```

`add` prompts for the database type, host, port, user, password, database (or
Oracle SID) and a connection name, assembles the DSN, **offers to connect and
verify it before storing**, and prints the exact `.mcp.json` snippet to paste.
The password prompt does not echo. Only the DSN is stored; the driver and
permissions live in `.mcp.json`.

`update` is how you rotate credentials later: pick the connection, type the new
values, done — no `.mcp.json` change.

### Testing a connection

`db-mcp keychain test <name>` reads that entry's DSN, connects, and reports the
server version and latency — or the driver's own error. The driver is inferred
from the DSN's URL scheme, so there is nothing to specify. The secret is never
printed; only `host:port/database` is shown.

`db-mcp test` does the same for whatever `DB_*` variables are in the
environment, which is how you debug a project's `.mcp.json` directly:

```sh
db-mcp test                                          # uses the ambient DB_* vars
DB_DRIVER=postgres DB_DSN_CMD='...' db-mcp test      # or set them inline
```

Both exit non-zero on failure, so they work in a script.

### Renaming a stored connection

macOS `security` has no rename. `db-mcp keychain rename old new` copies the
secret to the new service name, **verifies the copy reads back intact**, and
only then deletes the original — so an interrupted rename never loses the
credential. It refuses if the new name already exists, and prints the updated
`DB_DSN_CMD` line to paste into `.mcp.json`.

### Storing a DSN by hand

If you prefer not to use the CLI:

```sh
security add-generic-password -U -a navy-dev -s db-mcp/navy-dev -w 'oracle://user:pass@host:1521/service'
```

The `security` shell-out reads the item without a GUI prompt (the ACL is on the
`security` binary, not on db-mcp).

### DSN formats to store in the Keychain

| Driver | DSN |
|--------|-----|
| postgres | `postgres://user:pass@host:5432/db` |
| sqlserver | `sqlserver://user:pass@host:1433?database=db` |
| oracle (service) | `oracle://user:pass@host:1521/service` |
| oracle (SID) | `oracle://user:pass@host:1521/?SID=ORCL` |

These are the same strings the Go build wrote, so existing Keychain entries keep
working untouched. Verify a new one with `db-mcp keychain test <name>`.

SQL Server accepts extra options in the query string, e.g.
`?database=db&encrypt=true&trustservercertificate=true`. Encryption defaults to
off, matching the Go driver's default; the TDS login packet is encrypted either
way.

### Environment variables

| Var | Meaning | Default |
|-----|---------|---------|
| `DB_DRIVER` | `postgres` \| `sqlserver` \| `oracle` | required |
| `DB_DSN_CMD` | command whose stdout is the **full DSN** (e.g. macOS Keychain) | — |
| `DB_DSN` | full DSN inline (prefer `DB_DSN_CMD`) | — |
| `DB_PERMISSIONS` | comma list of `read,create,update,delete` | `read` |
| `DB_MAX_ROWS` | max rows returned per query | `500` |
| `DB_QUERY_TIMEOUT` | per-query timeout (Go-style duration, e.g. `30s`, `1m30s`) | `30s` |
| `DB_ALLOW_UNFILTERED_WRITES` | allow `UPDATE`/`DELETE` with no top-level `WHERE` | `false` |
| `DB_AUDIT_PATH` | audit log path | `<UserConfigDir>/db-mcp/audit.jsonl` |
| `DB_AUDIT_DISABLED` | set true to disable auditing | `false` |

`DB_DSN`/`DB_DSN_CMD` are mutually exclusive and cannot be combined with
`DB_PASSWORD`/`DB_PASSWORD_CMD`.

### Discrete-field mode (alternative to a DSN)

Instead of a DSN you can supply the parts and let the server assemble the
connection string. The password can still come from the Keychain via
`DB_PASSWORD_CMD`:

`DB_HOST`, `DB_PORT` (default 5432 / 1433 / 1521), `DB_USER`,
`DB_PASSWORD` **or** `DB_PASSWORD_CMD`, `DB_NAME` (Oracle: service name) **or**
`DB_ORACLE_SID`.

## Tools

The tools operate on the one configured database — there is no connection
parameter.

- **`query`** `{ sql }` — run one SQL statement. Reads return JSON rows (capped at
  `DB_MAX_ROWS`); writes return `rows_affected`.
- **`list_tables`** `{ schema? }` — tables **and views**, with a `table_type` per row.
- **`describe_table`** `{ table, schema? }` — columns, primary/unique constraints,
  foreign keys (both directions) and indexes.
- **`search_schema`** `{ pattern, type?, schema? }` — find tables and/or columns by
  case-insensitive name substring (`type`: `table` | `column`; SQL LIKE wildcards
  pass through).
- **`explain`** `{ sql }` — the engine's plan for a read-only statement without
  executing it (`EXPLAIN` / `EXPLAIN PLAN FOR` + `DBMS_XPLAN` / `SET SHOWPLAN_ALL`).
  Oracle needs `PLAN_TABLE` available to the user.

The introspection tools require `read` permission.

`DB_MAX_ROWS` bounds what is **fetched**, not merely what is returned: reads
stream through a server-side cursor (Postgres), a cancellable row stream (SQL
Server) or the driver's own `maxRows` (Oracle), so `SELECT *` against a large
table stays cheap.

## Audit log

Every statement the agent authors (the `query` and `explain` tools) is appended
to a JSONL audit file — reads and writes, successes and failures — with
timestamp, connection, classified operation, SQL text, row counts and duration.
Fixed catalog queries from the introspection tools and statements denied by the
permission gate (never executed) are not logged. No rotation is built in; the
file is plain JSONL for external tools to rotate.

## How permissions are enforced

Each statement is classified and rejected unless every operation it performs is
in `DB_PERMISSIONS`:

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
- `UPDATE`/`DELETE` with no top-level `WHERE` clause is denied unless
  `DB_ALLOW_UNFILTERED_WRITES` is set (a `WHERE` inside a subquery does not count).
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

- Supports PostgreSQL, SQL Server, Oracle. (MySQL/SQLite would each need a new
  adapter under `src/db/`.)
- DDL, `TRUNCATE`, `MERGE`, and stored procedures are deliberately denied.
- `INSERT … ON CONFLICT DO UPDATE` classifies as create only (upsert semantics
  are a future scope call).
- The agent inlines literal values in SQL (no separate bound-parameter argument yet).
- Oracle connects by host+port with service name or SID (no wallets / TNS aliases
  yet); `list_tables` excludes materialized views.
- The audit log has no built-in rotation and is not fsync'd per line.
- The keychain CLI is macOS-only (it shells out to `security`); the MCP server
  itself runs anywhere Node does.

### Differences from the Go build

Two driver-level behaviours differ, both deliberate:

- **Postgres `bigint`/`numeric` arrive as strings.** `pg` returns them that way,
  where Go's pgx returned integers. Keeping the string avoids silent precision
  loss when a value exceeds `Number.MAX_SAFE_INTEGER` during JSON serialisation.
- **Timestamps render in UTC** (`2026-07-29T12:34:56.000Z`) rather than with a
  local offset. Same instant, different spelling.

## Layout

```
src/
  index.ts        entry — no argv serves MCP, argv runs the CLI
  server.ts       serveStdio + McpServer
  tools.ts        the 5 MCP tools
  permissions.ts  SQL classifier and permission gate  ← security-critical
  config.ts       DB_* env -> ResolvedConfig
  connection.ts   lazy handle, DSN resolution
  audit.ts        JSONL auditor
  dsn.ts          build/parse the three DSN formats
  keychain.ts     macOS `security` shell-out
  db/             DbAdapter seam + postgres / mssql / oracle adapters
  cli/            commander wiring, prompts, connection probe
```

## Test

```sh
npm test        # classifier (security-critical core), config parsing, DSN
                # round-trips, cell caps, keychain parsing, error formatting
```

### Smoke harness

`src/smoke.ts` launches the built command over stdio as a real MCP client and
exercises every tool against a live database:

```sh
docker run -d --name db-mcp-smoke -p 5434:5432 -e POSTGRES_PASSWORD=smoke postgres:16
docker exec db-mcp-smoke psql -U postgres -c \
  "CREATE TABLE widgets (id int primary key, name text);"

npm run build
env DB_DRIVER=postgres DB_HOST=localhost DB_PORT=5434 DB_USER=postgres \
    DB_PASSWORD=smoke DB_NAME=postgres DB_PERMISSIONS=read,create \
    npm run smoke
```

Set `DB_DSN` (or `DB_DSN_CMD`) instead of the discrete fields to exercise the
full-DSN path. Prerequisites: a `widgets(id int primary key, name text)` table
and `read,create` but **not** delete — the harness asserts the delete, drop,
unfiltered-delete and multi-statement steps are denied. It inserts `id = 99`, so
delete that row between runs.

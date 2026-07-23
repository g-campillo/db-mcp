# db-mcp

A single MCP server that runs SQL against **PostgreSQL, SQL Server, or Oracle**,
where the CRUD operations the agent may perform are controlled per project.

- One binary, three databases (pure-Go drivers — **no Oracle Instant Client, no ODBC**).
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

## Build

Requires Go 1.23+ (the toolchain auto-fetches a newer one if a dependency needs it).

```sh
make install       # build and put db-mcp on your PATH (/usr/local/bin; prompts
                   # for sudo if needed). Then .mcp.json can just say "db-mcp".
```

No-sudo alternative: `make install PREFIX=~/.local` (ensure `~/.local/bin` is on
your PATH). `make` alone builds `./db-mcp` locally without installing.

Other targets: `make test` (vet + unit tests), `make smoke` (builds the
integration harness), `make clean`.

## Configure

Everything comes from the `env` block of the project's local `.mcp.json`. The
recommended setup keeps **no secret on disk**: the whole connection string lives
in the macOS Keychain and `DB_DSN_CMD` pulls it out.

```jsonc
{
  "mcpServers": {
    "db": {
      "command": "db-mcp",                     // on PATH after `make install`
      "env": {
        "DB_DRIVER": "oracle",                 // postgres | sqlserver | oracle
        "DB_PERMISSIONS": "read,create,update,delete",
        "DB_DSN_CMD": "security find-generic-password -s db-mcp/navy-dev -w"
      }
    }
  }
}
```

Store the connection in the Keychain with the built-in CLI — it prompts for the
database type, host, port, user, password, database (or Oracle SID) and a
connection name, assembles the DSN and saves it, then prints the exact
`.mcp.json` snippet to paste:

```sh
db-mcp keychain add                 # prompts, then stores db-mcp/<name>
db-mcp keychain update              # pick an existing connection, re-enter creds
db-mcp keychain list                # list stored connection names
```

`update` is how you rotate credentials later: pick the connection, type the new
values, done — no `.mcp.json` change. The password prompt does not echo. Only
the DSN is stored; the driver and permissions live in `.mcp.json`.

Equivalent manual command, if you prefer:

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

Verify the exact string with a quick connect test — driver DSN grammars differ
(especially Oracle wallets/TNS, which are not supported: use host + port).

### Environment variables

| Var | Meaning | Default |
|-----|---------|---------|
| `DB_DRIVER` | `postgres` \| `sqlserver` \| `oracle` | required |
| `DB_DSN_CMD` | command whose stdout is the **full DSN** (e.g. macOS Keychain) | — |
| `DB_DSN` | full DSN inline (prefer `DB_DSN_CMD`) | — |
| `DB_PERMISSIONS` | comma list of `read,create,update,delete` | `read` |
| `DB_MAX_ROWS` | max rows returned per query | `500` |
| `DB_QUERY_TIMEOUT` | per-query timeout (Go duration) | `30s` |
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
env DB_DRIVER=postgres DB_HOST=localhost DB_PORT=5433 DB_USER=postgres \
    DB_PASSWORD=smoke DB_NAME=postgres DB_PERMISSIONS=read,create ./smoke ./db-mcp
```

Set `DB_DSN` (or `DB_DSN_CMD`) instead of the discrete fields to exercise the
full-DSN path. Prerequisites: a `widgets(id int primary key, name text)` table
and `read,create` but **not** delete — the harness asserts the
delete/drop/unfiltered-delete steps are denied.

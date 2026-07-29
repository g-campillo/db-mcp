/**
 * Integration harness: launches the built db-mcp over stdio as a real MCP
 * client and exercises every tool against a live database.
 *
 *   npm run smoke [-- <path-to-entry>]
 *
 * The child inherits the caller's DB_* environment. Set DB_DSN (or DB_DSN_CMD)
 * to exercise the full-DSN path; otherwise use the discrete DB_HOST/DB_USER/
 * DB_NAME fields.
 *
 * Prerequisites: a widgets(id, name) table and a connection granting
 * read,create but NOT delete — the delete/drop steps assert denial.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

interface Step {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** true => the permission gate is expected to deny it */
  wantErr: boolean;
  /**
   * non-empty => output must contain this substring, compared
   * case-insensitively because Oracle reports identifiers in upper case.
   */
  wantText?: string;
  /** Extra structural check; returns a failure reason, or null when happy. */
  assert?: (parsed: unknown) => string | null;
}

/**
 * A plan, not the query's own rows. Each engine names its plan columns
 * differently, but none of them returns the selected column — so if `id` comes
 * back, the statement was executed instead of explained. That is exactly what
 * SQL Server did until `explain` switched from `query` to `batch`.
 */
function looksLikeAPlan(parsed: unknown): string | null {
  const columns = (parsed as { columns?: string[] }).columns ?? [];
  if (columns.length === 0) return "explain returned no columns";
  if (columns.some((c) => c.toLowerCase() === "id")) {
    return `explain returned the query's own rows (columns: ${columns.join(", ")})`;
  }
  return null;
}

const STEPS: Step[] = [
  { label: "list_tables", tool: "list_tables", args: {}, wantErr: false, wantText: "widgets" },
  {
    label: "describe widgets",
    tool: "describe_table",
    args: { table: "widgets" },
    wantErr: false,
    wantText: "constraints",
  },
  {
    label: "search schema",
    tool: "search_schema",
    args: { pattern: "widg" },
    wantErr: false,
    wantText: "widgets",
  },
  {
    label: "explain",
    tool: "explain",
    args: { sql: "SELECT id FROM widgets" },
    wantErr: false,
    assert: looksLikeAPlan,
  },
  {
    label: "read",
    tool: "query",
    args: { sql: "SELECT id, name FROM widgets ORDER BY id" },
    wantErr: false,
  },
  {
    label: "create (insert)",
    tool: "query",
    args: { sql: "INSERT INTO widgets (id, name) VALUES (99, 'smoke')" },
    wantErr: false,
  },
  {
    label: "read after insert",
    tool: "query",
    args: { sql: "SELECT id, name FROM widgets ORDER BY id" },
    wantErr: false,
    wantText: "smoke",
  },
  {
    label: "db error surfaces cleanly",
    tool: "query",
    args: { sql: "SELECT * FROM no_such_widget" },
    wantErr: true,
  },
  {
    label: "delete (should be denied)",
    tool: "query",
    args: { sql: "DELETE FROM widgets WHERE id = 99" },
    wantErr: true,
  },
  {
    label: "unfiltered delete (should be denied)",
    tool: "query",
    args: { sql: "DELETE FROM widgets" },
    wantErr: true,
  },
  {
    label: "drop (should be denied)",
    tool: "query",
    args: { sql: "DROP TABLE widgets" },
    wantErr: true,
  },
  {
    label: "multi-statement (should be denied)",
    tool: "query",
    args: { sql: "SELECT 1; DROP TABLE widgets" },
    wantErr: true,
  },
];

async function main(): Promise<void> {
  const entry = process.argv[2] ?? "dist/index.js";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  });

  const client = new Client({ name: "smoke", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.map((t) => t.name).join(" ")}`);

  let fails = 0;
  for (const step of STEPS) {
    let text: string;
    let isError: boolean;
    try {
      const res = await client.callTool({ name: step.tool, arguments: step.args });
      isError = res.isError === true;
      text = textOf(res);
    } catch (err) {
      console.log(`  [TRANSPORT-ERR] ${step.label}: ${err instanceof Error ? err.message : err}`);
      fails++;
      continue;
    }

    let status = "OK";
    if (isError !== step.wantErr) {
      status = "UNEXPECTED";
      fails++;
    } else if (step.wantText && !text.toLowerCase().includes(step.wantText.toLowerCase())) {
      status = `MISSING ${step.wantText}`;
      fails++;
    } else if (step.assert && !step.wantErr) {
      const reason = step.assert(JSON.parse(text));
      if (reason) {
        status = `ASSERT: ${reason}`;
        fails++;
      }
    }
    console.log(`  [${status}] ${step.label} -> ${trunc(text, 240)}`);
  }

  // Leave the table as we found it, so the harness is re-runnable.
  await client
    .callTool({ name: "query", arguments: { sql: "SELECT 1" } })
    .catch(() => undefined);

  await client.close();

  if (fails > 0) {
    console.error(`SMOKE FAIL: ${fails} step(s) did not behave as expected`);
    process.exit(1);
  }
  console.log("ALL OK");
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

main().catch((err: unknown) => {
  console.error(`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * SQL classification and the permission gate.
 *
 * This is the security-critical core: every statement the agent authors passes
 * through `authorize` before it reaches a database. It is a guard, not a
 * sandbox — pair it with a least-privilege database user.
 *
 * Ported line-for-line from the Go implementation so the two can be read side
 * by side. One language difference matters: Go indexes bytes, JavaScript
 * indexes UTF-16 code units. Every delimiter the scanner recognises is ASCII
 * and non-ASCII characters are copied through verbatim, so scanning by code
 * unit is equivalent here — a surrogate pair is never split, only passed along.
 */

import type { SqlDriver } from "./drivers.js";

/** A classified SQL operation (CRUD). */
export type Op = "read" | "create" | "update" | "delete";

/** The set of operations the agent is allowed to perform. */
export type PermSet = ReadonlySet<Op>;

const ALL_OPS: readonly Op[] = ["read", "create", "update", "delete"];

function isOp(s: string): s is Op {
  return (ALL_OPS as readonly string[]).includes(s);
}

/**
 * Parses a comma-separated permission list like "read,create". Empty input
 * defaults to read-only. Unknown tokens are an error.
 */
export function parsePerms(s: string): PermSet {
  const ps = new Set<Op>();
  for (const raw of s.split(",")) {
    const tok = raw.trim().toLowerCase();
    if (tok === "") continue;
    if (!isOp(tok)) {
      throw new Error(`unknown permission "${tok}" (valid: read, create, update, delete)`);
    }
    ps.add(tok);
  }
  if (ps.size === 0) ps.add("read");
  return ps;
}

/** Lists permitted ops in canonical order. */
export function permsToString(ps: PermSet): string {
  return ALL_OPS.filter((o) => ps.has(o)).join(", ");
}

/** What `authorize` needs from the connection config. */
export interface AuthConfig {
  sqlDriver: SqlDriver;
  perms: PermSet;
  allowUnfilteredWrites: boolean;
}

/**
 * Classifies sql and verifies every operation it performs is allowed on the
 * connection. Returns the operation(s) involved — more than one only for a
 * data-modifying CTE (e.g. WITH x AS (DELETE ... RETURNING ...) INSERT ...).
 * UPDATE/DELETE with no top-level WHERE clause is denied unless the connection
 * sets allowUnfilteredWrites.
 */
export function authorize(sql: string, cfg: AuthConfig): Op[] {
  const { ops, unfiltered } = classify(sql, cfg.sqlDriver);
  for (const op of ops) {
    if (!cfg.perms.has(op)) {
      throw new Error(
        `operation "${op}" is not permitted (allowed: ${permsToString(cfg.perms)})`,
      );
    }
  }
  if (unfiltered && !cfg.allowUnfilteredWrites) {
    throw new Error(
      "UPDATE/DELETE without a WHERE clause is not permitted on this connection (set allow_unfiltered_writes to override)",
    );
  }
  return ops;
}

interface Classification {
  ops: Op[];
  unfiltered: boolean;
}

function classify(sql: string, driver: SqlDriver): Classification {
  const scrubbed = scrub(sql, driver);
  if (multiStatement(scrubbed)) {
    throw new Error("only one statement per call is allowed");
  }
  const { ops, unfiltered } = classifyStmt(tokenize(scrubbed));
  return { ops: dedupeOps(ops), unfiltered };
}

/**
 * A word (uppercased) or one of the punctuation characters '(' ')' ','.
 * Exactly one of the two fields is set, mirroring the Go struct's zero values.
 */
interface SqlToken {
  word: string;
  ch: string;
}

function isWordChar(c: string): boolean {
  return (
    c === "_" ||
    c === "$" ||
    c === "#" ||
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9")
  );
}

function tokenize(scrubbed: string): SqlToken[] {
  const toks: SqlToken[] = [];
  for (let i = 0; i < scrubbed.length; ) {
    const c = scrubbed[i]!;
    if (c === "(" || c === ")" || c === ",") {
      toks.push({ word: "", ch: c });
      i++;
    } else if (isWordChar(c)) {
      let j = i;
      while (j < scrubbed.length && isWordChar(scrubbed[j]!)) j++;
      toks.push({ word: scrubbed.slice(i, j).toUpperCase(), ch: "" });
      i = j;
    } else {
      i++;
    }
  }
  return toks;
}

/**
 * Classifies one statement scope by its leading verb. For WITH it recurses into
 * every CTE body and the main statement, so a write verb only counts in verb
 * position — never as an identifier.
 */
function classifyStmt(toks: SqlToken[]): Classification {
  let i = 0;
  while (i < toks.length && toks[i]!.ch === "(") i++;
  if (i >= toks.length || toks[i]!.word === "") {
    throw new Error("empty statement");
  }
  const verb = toks[i]!.word;
  const rest = toks.slice(i + 1);
  switch (verb) {
    case "SELECT":
    case "VALUES":
    case "TABLE":
      if (hasScopeWord(rest, "INTO")) {
        throw new Error("SELECT ... INTO creates a table and is not permitted");
      }
      return { ops: ["read"], unfiltered: false };
    case "INSERT":
      return { ops: ["create"], unfiltered: false };
    case "UPDATE":
      return { ops: ["update"], unfiltered: !hasScopeWord(rest, "WHERE") };
    case "DELETE":
      return { ops: ["delete"], unfiltered: !hasScopeWord(rest, "WHERE") };
    case "WITH":
      return classifyWith(rest);
    default:
      throw new Error(
        `statement type "${verb}" is not permitted; only SELECT, INSERT, UPDATE and DELETE are allowed`,
      );
  }
}

/**
 * Reports whether word occurs at paren-depth 0 of this scope; scanning stops
 * where the scope's parentheses close.
 */
function hasScopeWord(toks: SqlToken[], word: string): boolean {
  let depth = 0;
  for (const t of toks) {
    if (t.ch === "(") {
      depth++;
    } else if (t.ch === ")") {
      depth--;
      if (depth < 0) return false;
    } else if (depth === 0 && t.word === word) {
      return true;
    }
  }
  return false;
}

const STMT_KEYWORDS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "VALUES",
  "TABLE",
  "EXEC",
  "EXECUTE",
  "CALL",
]);

/**
 * Walks a WITH clause at paren-depth 0. A '(' directly after AS / AS [NOT]
 * MATERIALIZED opens a CTE body (recursed); the main statement is the first
 * depth-0 statement keyword outside a body, or a bare '(' directly following a
 * body (parenthesised main statement). Anything else — no main statement, or a
 * non-CRUD main verb — is an error, preserving default-deny.
 */
function classifyWith(toks: SqlToken[]): Classification {
  const ops: Op[] = [];
  let unfiltered = false;
  let depth = 0;
  let lastWord = ""; // most recent depth-0 word, cleared at ',' and after a body
  let bodySeen = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.ch === "(") {
      if (depth === 0 && (lastWord === "AS" || lastWord === "MATERIALIZED")) {
        const close = matchParen(toks, i);
        const body = classifyStmt(toks.slice(i + 1, close));
        ops.push(...body.ops);
        unfiltered = unfiltered || body.unfiltered;
        bodySeen = true;
        lastWord = "";
        i = close;
        continue;
      }
      if (depth === 0 && bodySeen && lastWord === "") {
        // parenthesised main statement after the CTE list
        const main = classifyStmt(toks.slice(i));
        return { ops: [...ops, ...main.ops], unfiltered: unfiltered || main.unfiltered };
      }
      depth++;
    } else if (t.ch === ")") {
      depth--;
    } else if (t.ch === ",") {
      if (depth === 0) lastWord = "";
    } else if (t.word !== "" && depth === 0) {
      if (STMT_KEYWORDS.has(t.word)) {
        const main = classifyStmt(toks.slice(i));
        return { ops: [...ops, ...main.ops], unfiltered: unfiltered || main.unfiltered };
      }
      lastWord = t.word;
    }
  }
  throw new Error("could not find the main statement after WITH");
}

/**
 * Returns the index of the ')' matching the '(' at open, or toks.length when
 * unbalanced.
 */
function matchParen(toks: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const ch = toks[i]!.ch;
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return toks.length;
}

function dedupeOps(ops: Op[]): Op[] {
  return [...new Set(ops)];
}

/**
 * Reports whether the statement yields a result set, so the caller can pick a
 * row-returning query over an exec that reports rows-affected.
 */
export function returnsRows(sql: string, driver: SqlDriver): boolean {
  const scrubbed = scrub(sql, driver);
  switch (leadingKeyword(scrubbed)) {
    case "SELECT":
    case "WITH":
      return true;
  }
  const w = wordSet(scrubbed);
  return w.has("RETURNING") || w.has("OUTPUT");
}

/**
 * Reports whether scrubbed SQL holds more than one statement (any semicolon
 * other than trailing ones).
 */
function multiStatement(scrubbed: string): boolean {
  const s = scrubbed.trim().replace(/[; \t\r\n]+$/, "");
  return s.includes(";");
}

function leadingKeyword(scrubbed: string): string {
  const fields = scrubbed.replace(/^[ \t\r\n(]+/, "").split(/\s+/).filter((f) => f !== "");
  return (fields[0] ?? "").toUpperCase();
}

function wordSet(scrubbed: string): Set<string> {
  const words = scrubbed.toUpperCase().split(/[^_$#A-Z0-9]+/);
  return new Set(words.filter((w) => w !== ""));
}

// Scrub states.
const NORMAL = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const SINGLE = 3;
const DOUBLE = 4;
const BRACKET = 5;
const BACKTICK = 6;

/**
 * Replaces comments and quoted literals/identifiers with spaces so that a
 * semicolon or keyword hidden inside one cannot fool classification. It is a
 * guard, not a full SQL parser — pair it with a least-privilege DB user.
 * For postgres it also blanks $tag$...$tag$ dollar-quoted literals.
 */
export function scrub(sql: string, driver: SqlDriver): string {
  let out = "";
  let state = NORMAL;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    switch (state) {
      case NORMAL:
        if (c === "$" && driver === "pgx") {
          const end = dollarQuoteEnd(sql, i);
          if (end !== null) {
            out += " ";
            i = end;
          } else {
            out += c;
          }
        } else if (c === "-" && sql[i + 1] === "-") {
          state = LINE_COMMENT;
          i++;
          out += " ";
        } else if (c === "/" && sql[i + 1] === "*") {
          state = BLOCK_COMMENT;
          i++;
          out += " ";
        } else if (c === "'") {
          state = SINGLE;
          out += " ";
        } else if (c === '"') {
          state = DOUBLE;
          out += " ";
        } else if (c === "[") {
          state = BRACKET;
          out += " ";
        } else if (c === "`") {
          state = BACKTICK;
          out += " ";
        } else {
          out += c;
        }
        break;
      case LINE_COMMENT:
        if (c === "\n") {
          state = NORMAL;
          out += "\n";
        }
        break;
      case BLOCK_COMMENT:
        if (c === "*" && sql[i + 1] === "/") {
          state = NORMAL;
          i++;
          out += " ";
        }
        break;
      case SINGLE:
        if (c === "'") {
          if (sql[i + 1] === "'") i++; // '' escape
          else state = NORMAL;
        }
        break;
      case DOUBLE:
        if (c === '"') {
          if (sql[i + 1] === '"') i++;
          else state = NORMAL;
        }
        break;
      case BRACKET:
        if (c === "]") {
          if (sql[i + 1] === "]") i++;
          else state = NORMAL;
        }
        break;
      case BACKTICK:
        if (c === "`") {
          if (sql[i + 1] === "`") i++;
          else state = NORMAL;
        }
        break;
    }
  }
  return out;
}

/**
 * Parses a postgres dollar-quote delimiter ($$ or $tag$) starting at sql[i] ===
 * '$'. Returns the index of the closing delimiter's last character — or the end
 * of the string when unterminated — or null when no valid delimiter is found.
 * Positional params like $1 do not match (tags cannot start with a digit).
 */
function dollarQuoteEnd(sql: string, i: number): number | null {
  let j = i + 1;
  while (j < sql.length && isTagChar(sql[j]!)) j++;
  if (j >= sql.length || sql[j] !== "$") return null;
  if (j > i + 1) {
    const c = sql[i + 1]!;
    if (!(c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"))) return null;
  }
  const delim = sql.slice(i, j + 1);
  const k = sql.indexOf(delim, j + 1);
  if (k < 0) return sql.length - 1;
  return k + delim.length - 1;
}

function isTagChar(c: string): boolean {
  return (
    c === "_" ||
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9")
  );
}

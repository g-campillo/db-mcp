//! SQL classification and the permission gate.
//!
//! This is the security-critical core: every statement the agent authors passes
//! through `authorize` before it reaches a database. It is a guard, not a
//! sandbox; pair it with a least-privilege database user.
//!
//! Ported line for line from the earlier implementations so they can be read
//! side by side. The scanner works on bytes: every delimiter it recognises is
//! ASCII, and a multi-byte UTF-8 character never contains an ASCII byte, so a
//! character is never split, only copied through or blanked whole.

use std::collections::{BTreeSet, HashSet};
use std::fmt;

use anyhow::{Result, bail};

use crate::drivers::SqlDriver;

/// A classified SQL operation (CRUD). The declaration order is the canonical
/// order, so a `PermSet` iterates read, create, update, delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Op {
    Read,
    Create,
    Update,
    Delete,
}

impl Op {
    /// Every operation, in canonical order.
    pub const ALL: [Op; 4] = [Op::Read, Op::Create, Op::Update, Op::Delete];

    /// The lower-case name used in DB_PERMISSIONS, messages and the audit log.
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Read => "read",
            Op::Create => "create",
            Op::Update => "update",
            Op::Delete => "delete",
        }
    }
}

impl fmt::Display for Op {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The set of operations the agent is allowed to perform.
pub type PermSet = BTreeSet<Op>;

/// Parses a comma-separated permission list like "read,create". Empty input
/// defaults to read-only. Unknown tokens are an error.
pub fn parse_perms(s: &str) -> Result<PermSet> {
    let mut ps = PermSet::new();
    for raw in s.split(',') {
        let tok = raw.trim().to_lowercase();
        if tok.is_empty() {
            continue;
        }
        let Some(op) = Op::ALL.into_iter().find(|op| op.as_str() == tok) else {
            bail!("unknown permission \"{tok}\" (valid: read, create, update, delete)");
        };
        ps.insert(op);
    }
    if ps.is_empty() {
        ps.insert(Op::Read);
    }
    Ok(ps)
}

/// Lists permitted ops in canonical order, e.g. "read, delete".
pub fn perms_to_string(ps: &PermSet) -> String {
    ps.iter()
        .map(|op| op.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Classifies `sql` and verifies every operation it performs is allowed on the
/// connection. Returns the operation(s) involved; more than one only for a
/// data-modifying CTE (e.g. WITH x AS (DELETE ... RETURNING ...) INSERT ...).
/// UPDATE/DELETE with no top-level WHERE clause is denied unless
/// `allow_unfiltered_writes` is set.
pub fn authorize(
    sql: &str,
    driver: SqlDriver,
    perms: &PermSet,
    allow_unfiltered_writes: bool,
) -> Result<Vec<Op>> {
    let Classification { ops, unfiltered } = classify(sql, driver)?;
    for op in &ops {
        if !perms.contains(op) {
            bail!(
                "operation \"{op}\" is not permitted (allowed: {})",
                perms_to_string(perms)
            );
        }
    }
    if unfiltered && !allow_unfiltered_writes {
        bail!(
            "UPDATE/DELETE without a WHERE clause is not permitted on this connection (set allow_unfiltered_writes to override)"
        );
    }
    Ok(ops)
}

fn classify(sql: &str, driver: SqlDriver) -> Result<Classification> {
    let scrubbed = scrub(sql, driver);
    if multi_statement(&scrubbed) {
        bail!("only one statement per call is allowed");
    }
    let Classification { ops, unfiltered } = classify_stmt(&tokenize(&scrubbed))?;
    Ok(Classification {
        ops: dedupe_ops(ops),
        unfiltered,
    })
}

/// Reports whether scrubbed SQL holds more than one statement: any semicolon
/// other than trailing ones.
fn multi_statement(scrubbed: &str) -> bool {
    scrubbed
        .trim()
        .trim_end_matches([';', ' ', '\t', '\r', '\n'])
        .contains(';')
}

/// Drops repeated ops, keeping the first occurrence of each in order.
fn dedupe_ops(ops: Vec<Op>) -> Vec<Op> {
    let mut out = Vec::with_capacity(ops.len());
    for op in ops {
        if !out.contains(&op) {
            out.push(op);
        }
    }
    out
}

/// Reports whether the statement yields a result set, so the caller can pick a
/// row-returning query over an exec that reports rows affected.
pub fn returns_rows(sql: &str, driver: SqlDriver) -> bool {
    let scrubbed = scrub(sql, driver);
    if matches!(leading_keyword(&scrubbed).as_str(), "SELECT" | "WITH") {
        return true;
    }
    let words = word_set(&scrubbed);
    words.contains("RETURNING") || words.contains("OUTPUT")
}

/// The first whitespace-separated field after any leading whitespace and '(',
/// upper-cased.
fn leading_keyword(scrubbed: &str) -> String {
    scrubbed
        .trim_start_matches([' ', '\t', '\r', '\n', '('])
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase()
}

/// Every upper-cased run of [_$#A-Z0-9] in the text.
fn word_set(scrubbed: &str) -> HashSet<String> {
    scrubbed
        .to_uppercase()
        .split(|c: char| {
            !(c == '_' || c == '$' || c == '#' || c.is_ascii_uppercase() || c.is_ascii_digit())
        })
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A word (upper-cased) or one of the punctuation characters that give SQL
/// its structure: '(' ')' ','.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    Open,
    Close,
    Comma,
}

fn is_word_byte(c: u8) -> bool {
    c == b'_' || c == b'$' || c == b'#' || c.is_ascii_alphanumeric()
}

/// Splits scrubbed SQL into tokens. Anything that is neither a word byte nor
/// '(' ')' ',' (whitespace, operators, non-ASCII) only separates tokens.
fn tokenize(scrubbed: &str) -> Vec<Token> {
    let b = scrubbed.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => {
                toks.push(Token::Open);
                i += 1;
            }
            b')' => {
                toks.push(Token::Close);
                i += 1;
            }
            b',' => {
                toks.push(Token::Comma);
                i += 1;
            }
            c if is_word_byte(c) => {
                let start = i;
                while i < b.len() && is_word_byte(b[i]) {
                    i += 1;
                }
                toks.push(Token::Word(scrubbed[start..i].to_ascii_uppercase()));
            }
            _ => i += 1,
        }
    }
    toks
}

/// The operations one statement scope performs, and whether an UPDATE/DELETE
/// in it has no top-level WHERE.
#[derive(Debug, Default)]
struct Classification {
    ops: Vec<Op>,
    unfiltered: bool,
}

/// Classifies one statement scope by its leading verb. For WITH it recurses into
/// every CTE body and the main statement, so a write verb only counts in verb
/// position, never as an identifier.
fn classify_stmt(toks: &[Token]) -> Result<Classification> {
    let start = toks
        .iter()
        .position(|t| *t != Token::Open)
        .unwrap_or(toks.len());
    let Some(Token::Word(verb)) = toks.get(start) else {
        bail!("empty statement");
    };
    let rest = &toks[start + 1..];
    let (op, unfiltered) = match verb.as_str() {
        "SELECT" | "VALUES" | "TABLE" => {
            if has_scope_word(rest, "INTO") {
                bail!("SELECT ... INTO creates a table and is not permitted");
            }
            (Op::Read, false)
        }
        "INSERT" => (Op::Create, false),
        "UPDATE" => (Op::Update, !has_scope_word(rest, "WHERE")),
        "DELETE" => (Op::Delete, !has_scope_word(rest, "WHERE")),
        "WITH" => return classify_with(rest),
        _ => bail!(
            "statement type \"{verb}\" is not permitted; only SELECT, INSERT, UPDATE and DELETE are allowed"
        ),
    };
    Ok(Classification {
        ops: vec![op],
        unfiltered,
    })
}

/// Reports whether `word` occurs at paren depth 0 of this scope; scanning stops
/// where the scope's parentheses close.
fn has_scope_word(toks: &[Token], word: &str) -> bool {
    let mut depth: i32 = 0;
    for t in toks {
        match t {
            Token::Open => depth += 1,
            Token::Close => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Token::Word(w) if depth == 0 && w == word => return true,
            _ => {}
        }
    }
    false
}

/// Words that start a statement. Inside a WITH, the first of these at depth 0
/// outside a CTE body begins the main statement.
const STMT_KEYWORDS: [&str; 10] = [
    "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE", "EXEC", "EXECUTE", "CALL",
];

/// Walks a WITH clause at paren depth 0. A '(' directly after AS / AS [NOT]
/// MATERIALIZED opens a CTE body (recursed); the main statement is the first
/// depth-0 statement keyword outside a body, or a bare '(' directly following a
/// body (parenthesised main statement). Anything else (no main statement, or a
/// non-CRUD main verb) is an error, preserving default-deny.
fn classify_with(toks: &[Token]) -> Result<Classification> {
    let mut ops = Vec::new();
    let mut unfiltered = false;
    let mut depth: i32 = 0;
    // The most recent depth-0 word, cleared at ',' and after a body.
    let mut last_word = "";
    let mut body_seen = false;

    let mut i = 0;
    while i < toks.len() {
        match &toks[i] {
            Token::Open => {
                if depth == 0 && (last_word == "AS" || last_word == "MATERIALIZED") {
                    let close = match_paren(toks, i);
                    let body = classify_stmt(&toks[i + 1..close])?;
                    ops.extend(body.ops);
                    unfiltered |= body.unfiltered;
                    body_seen = true;
                    last_word = "";
                    i = close + 1;
                    continue;
                }
                if depth == 0 && body_seen && last_word.is_empty() {
                    // A parenthesised main statement after the CTE list.
                    let main = classify_stmt(&toks[i..])?;
                    ops.extend(main.ops);
                    return Ok(Classification {
                        ops,
                        unfiltered: unfiltered || main.unfiltered,
                    });
                }
                depth += 1;
            }
            Token::Close => depth -= 1,
            Token::Comma => {
                if depth == 0 {
                    last_word = "";
                }
            }
            Token::Word(w) => {
                if depth == 0 {
                    if STMT_KEYWORDS.contains(&w.as_str()) {
                        let main = classify_stmt(&toks[i..])?;
                        ops.extend(main.ops);
                        return Ok(Classification {
                            ops,
                            unfiltered: unfiltered || main.unfiltered,
                        });
                    }
                    last_word = w;
                }
            }
        }
        i += 1;
    }
    bail!("could not find the main statement after WITH")
}

/// Returns the index of the ')' matching the '(' at `open`, or `toks.len()`
/// when unbalanced.
fn match_paren(toks: &[Token], open: usize) -> usize {
    let mut depth: i32 = 0;
    for (i, t) in toks.iter().enumerate().skip(open) {
        match t {
            Token::Open => depth += 1,
            Token::Close => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
    }
    toks.len()
}

/// Where `scrub` is: in live SQL, or inside something to blank out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScrubState {
    Normal,
    LineComment,
    BlockComment,
    Single,
    Double,
    Bracket,
    Backtick,
}

/// Replaces comments and quoted literals/identifiers with spaces so that a
/// semicolon or keyword hidden inside one cannot fool classification. It is a
/// guard, not a full SQL parser; pair it with a least-privilege DB user.
/// For postgres it also blanks $tag$...$tag$ dollar-quoted literals.
fn scrub(sql: &str, driver: SqlDriver) -> String {
    use ScrubState::*;

    let b = sql.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut state = Normal;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        match state {
            Normal => {
                if c == b'$' && driver == SqlDriver::Pgx {
                    if let Some(end) = dollar_quote_end(b, i) {
                        out.push(b' ');
                        i = end;
                    } else {
                        out.push(c);
                    }
                } else if c == b'-' && next == Some(b'-') {
                    state = LineComment;
                    i += 1;
                    out.push(b' ');
                } else if c == b'/' && next == Some(b'*') {
                    state = BlockComment;
                    i += 1;
                    out.push(b' ');
                } else if c == b'\'' {
                    state = Single;
                    out.push(b' ');
                } else if c == b'"' {
                    state = Double;
                    out.push(b' ');
                } else if c == b'[' {
                    state = Bracket;
                    out.push(b' ');
                } else if c == b'`' {
                    state = Backtick;
                    out.push(b' ');
                } else {
                    out.push(c);
                }
            }
            LineComment => {
                if c == b'\n' {
                    state = Normal;
                    out.push(b'\n');
                }
            }
            BlockComment => {
                if c == b'*' && next == Some(b'/') {
                    state = Normal;
                    i += 1;
                    out.push(b' ');
                }
            }
            Single | Double | Bracket | Backtick => {
                let close = match state {
                    Single => b'\'',
                    Double => b'"',
                    Bracket => b']',
                    _ => b'`',
                };
                if c == close {
                    if next == Some(close) {
                        i += 1; // a doubled delimiter is an escaped one, e.g. ''
                    } else {
                        state = Normal;
                    }
                }
            }
        }
        i += 1;
    }
    // Only whole characters are ever copied or dropped, so this is valid UTF-8.
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses a postgres dollar-quote delimiter ($$ or $tag$) starting at
/// `b[i] == b'$'`. Returns the index of the closing delimiter's last byte (or
/// of the input's last byte when unterminated), or `None` when no valid
/// delimiter starts here. Positional params like $1 do not match, because a
/// tag cannot start with a digit.
fn dollar_quote_end(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < b.len() && is_tag_byte(b[j]) {
        j += 1;
    }
    if j >= b.len() || b[j] != b'$' {
        return None;
    }
    if j > i + 1 {
        let first = b[i + 1];
        if !(first == b'_' || first.is_ascii_alphabetic()) {
            return None;
        }
    }
    let delim = &b[i..=j];
    let body = &b[j + 1..];
    match body.windows(delim.len()).position(|w| w == delim) {
        Some(k) => Some(j + 1 + k + delim.len() - 1),
        None => Some(b.len() - 1),
    }
}

fn is_tag_byte(c: u8) -> bool {
    c == b'_' || c.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ops: &[Op]) -> PermSet {
        ops.iter().copied().collect()
    }

    #[test]
    fn parses_permission_lists() {
        use Op::*;
        let cases: [(&str, &[Op]); 5] = [
            ("", &[Read]),
            ("  ", &[Read]),
            ("read", &[Read]),
            ("read,create,update,delete", &[Read, Create, Update, Delete]),
            (" READ , Create ", &[Read, Create]),
        ];
        for (input, want) in cases {
            let got = parse_perms(input).unwrap();
            assert_eq!(got, set(want), "parse_perms({input:?})");
        }
    }

    #[test]
    fn rejects_unknown_permissions() {
        for input in ["read,write", "drop"] {
            let err = parse_perms(input).unwrap_err();
            assert!(
                err.to_string().contains("unknown permission"),
                "{input:?}: {err}"
            );
        }
    }

    #[test]
    fn renders_permitted_ops_in_canonical_order() {
        assert_eq!(
            perms_to_string(&parse_perms("delete,read").unwrap()),
            "read, delete"
        );
    }

    #[test]
    fn authorize_gates_each_statement() {
        let all = set(&Op::ALL);
        let ro = set(&[Op::Read]);
        let rd = set(&[Op::Read, Op::Delete]);
        let create_only = set(&[Op::Create]);

        // (name, sql, perms, want_err)
        let cases = [
            ("select read-only ok", "SELECT * FROM users", &ro, false),
            ("lowercase select ok", "select id from t", &ro, false),
            ("select denied without read", "SELECT 1", &create_only, true),
            (
                "insert denied read-only",
                "INSERT INTO t VALUES (1)",
                &ro,
                true,
            ),
            (
                "insert ok with create",
                "INSERT INTO t (a) VALUES (1)",
                &all,
                false,
            ),
            ("update ok", "UPDATE t SET x = 1 WHERE id = 2", &all, false),
            ("update denied read-only", "UPDATE t SET x = 1", &ro, true),
            (
                "delete denied read-only",
                "DELETE FROM t WHERE id = 1",
                &ro,
                true,
            ),
            (
                "delete ok with delete",
                "DELETE FROM t WHERE id = 1",
                &rd,
                false,
            ),
            ("drop denied always", "DROP TABLE t", &all, true),
            (
                "create denied always",
                "CREATE TABLE t (id int)",
                &all,
                true,
            ),
            ("alter denied always", "ALTER TABLE t ADD c int", &all, true),
            ("truncate denied always", "TRUNCATE TABLE t", &all, true),
            (
                "merge denied always",
                "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.a=s.a",
                &all,
                true,
            ),
            ("exec denied always", "EXEC sp_who", &all, true),
            ("call denied always", "CALL my_proc()", &all, true),
            ("grant denied always", "GRANT SELECT ON t TO u", &all, true),
            (
                "multi-statement rejected",
                "SELECT 1; DROP TABLE t",
                &all,
                true,
            ),
            ("trailing semicolon ok", "SELECT 1;", &ro, false),
            (
                "semicolon in string is not a 2nd stmt",
                "SELECT ';' AS x",
                &ro,
                false,
            ),
            (
                "semicolon in comment is not a 2nd stmt",
                "SELECT 1 /* ; DROP TABLE t ; */",
                &ro,
                false,
            ),
            (
                "line comment then live stmt rejected",
                "SELECT 1 -- note\n; DROP TABLE t",
                &all,
                true,
            ),
            (
                "select into denied",
                "SELECT * INTO new_t FROM t",
                &all,
                true,
            ),
            (
                "updated_at is not UPDATE",
                "SELECT updated_at FROM t",
                &ro,
                false,
            ),
            (
                "column named into in string ok",
                "SELECT 'into' AS k FROM t",
                &ro,
                false,
            ),
            (
                "read-only CTE ok",
                "WITH c AS (SELECT 1 AS n) SELECT * FROM c",
                &ro,
                false,
            ),
            (
                "write CTE gated by inner verb",
                "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)",
                &ro,
                true,
            ),
            (
                "write CTE ok when delete allowed",
                "WITH c AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM c)",
                &rd,
                false,
            ),
            (
                "insert-into CTE not mistaken for SELECT INTO",
                "WITH c AS (SELECT 1 AS n) INSERT INTO t (n) SELECT n FROM c",
                &all,
                false,
            ),
            ("empty rejected", "   ", &all, true),
            ("leading paren select ok", "(SELECT 1)", &ro, false),
            ("block comment lead ok", "/* hi */ SELECT 1", &ro, false),
        ];
        for (name, sql, perms, want_err) in cases {
            let res = authorize(sql, SqlDriver::Pgx, perms, false);
            assert_eq!(res.is_err(), want_err, "{name}: {sql:?} gave {res:?}");
        }
    }

    /// The token-scanner WITH handling, the WHERE guard and postgres
    /// dollar-quoting.
    #[test]
    fn classifier_v2() {
        use SqlDriver::{Pgx, SqlServer};
        let all = set(&Op::ALL);
        let ro = set(&[Op::Read]);
        let rd = set(&[Op::Read, Op::Delete]);

        // (name, sql, driver, perms, allow_unfiltered, want_err)
        let cases = [
            // false positives fixed by verb-position scanning
            (
                "FOR UPDATE inside CTE is a read",
                "WITH c AS (SELECT id FROM t FOR UPDATE) SELECT * FROM c",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "write verbs as column names are a read",
                "WITH c AS (SELECT update, insert, delete FROM audit_log) SELECT * FROM c",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "top-level FOR UPDATE stays a read",
                "SELECT id FROM t FOR UPDATE",
                Pgx,
                &ro,
                false,
                false,
            ),
            // must-not-break: pg data-modifying CTEs are still writes
            (
                "data-modifying CTE still needs delete",
                "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x",
                Pgx,
                &ro,
                false,
                true,
            ),
            (
                "data-modifying CTE ok with delete",
                "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x",
                Pgx,
                &rd,
                false,
                false,
            ),
            // structural WITH forms
            (
                "NOT MATERIALIZED CTE",
                "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "MATERIALIZED CTE",
                "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "nested WITH",
                "WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "CTE column list",
                "WITH c(a, b) AS (SELECT 1, 2) SELECT * FROM c",
                Pgx,
                &ro,
                false,
                false,
            ),
            // security: non-CRUD main verbs after a CTE are denied
            (
                "CALL after CTE denied",
                "WITH x AS (SELECT 1) CALL p()",
                Pgx,
                &all,
                false,
                true,
            ),
            (
                "EXEC after CTE denied",
                "WITH x AS (SELECT 1) EXEC sp_who",
                Pgx,
                &all,
                false,
                true,
            ),
            // WHERE guard
            (
                "unfiltered DELETE denied",
                "DELETE FROM t",
                Pgx,
                &rd,
                false,
                true,
            ),
            (
                "unfiltered DELETE allowed with flag",
                "DELETE FROM t",
                Pgx,
                &rd,
                true,
                false,
            ),
            (
                "unfiltered UPDATE denied",
                "UPDATE t SET x = 1",
                Pgx,
                &all,
                false,
                true,
            ),
            (
                "WHERE only in subquery still unfiltered",
                "UPDATE t SET x = (SELECT y FROM u WHERE u.id = 1)",
                Pgx,
                &all,
                false,
                true,
            ),
            (
                "DELETE with WHERE subquery ok",
                "DELETE FROM t WHERE id IN (SELECT id FROM s)",
                Pgx,
                &rd,
                false,
                false,
            ),
            (
                "unfiltered write inside CTE denied",
                "WITH x AS (DELETE FROM t) SELECT 1",
                Pgx,
                &rd,
                false,
                true,
            ),
            (
                "unfiltered write inside CTE allowed with flag",
                "WITH x AS (DELETE FROM t) SELECT 1",
                Pgx,
                &rd,
                true,
                false,
            ),
            // postgres dollar-quoting
            (
                "semicolon in dollar quote is not a 2nd stmt",
                "SELECT $$; DROP TABLE t$$",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "same input on sqlserver keeps old behavior",
                "SELECT $$; DROP TABLE t$$",
                SqlServer,
                &ro,
                false,
                true,
            ),
            (
                "write verb in tagged dollar quote is a read",
                "WITH c AS (SELECT $tag$DELETE$tag$ AS x) SELECT * FROM c",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "apostrophe in dollar quote does not desync",
                "SELECT $$it's; fine$$ AS x",
                Pgx,
                &ro,
                false,
                false,
            ),
            (
                "positional param unaffected",
                "SELECT $1",
                Pgx,
                &ro,
                false,
                false,
            ),
        ];
        for (name, sql, driver, perms, allow_unfiltered, want_err) in cases {
            let res = authorize(sql, driver, perms, allow_unfiltered);
            assert_eq!(res.is_err(), want_err, "{name}: {sql:?} gave {res:?}");
        }
    }

    #[test]
    fn reports_both_ops_for_a_data_modifying_cte() {
        let sql = "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x";
        let ops = authorize(sql, SqlDriver::Pgx, &set(&[Op::Read, Op::Delete]), false).unwrap();
        assert_eq!(set(&ops), set(&[Op::Delete, Op::Read]));
    }

    #[test]
    fn dedupes_repeated_ops() {
        let sql = "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a";
        let ops = authorize(sql, SqlDriver::Pgx, &set(&[Op::Read]), false).unwrap();
        assert_eq!(ops, vec![Op::Read]);
    }

    #[test]
    fn where_guard_error_mentions_the_override_flag() {
        let rd = set(&[Op::Read, Op::Delete]);
        let err = authorize("DELETE FROM t", SqlDriver::Pgx, &rd, false).unwrap_err();
        assert!(err.to_string().contains("allow_unfiltered_writes"), "{err}");
    }

    #[test]
    fn detects_statements_that_return_rows() {
        let cases = [
            ("SELECT 1", true),
            ("WITH c AS (SELECT 1) SELECT * FROM c", true),
            ("INSERT INTO t VALUES (1)", false),
            ("UPDATE t SET x = 1", false),
            ("DELETE FROM t", false),
            ("INSERT INTO t (a) VALUES (1) RETURNING id", true),
            ("UPDATE t SET x = 1 OUTPUT inserted.id", true),
        ];
        for (sql, want) in cases {
            assert_eq!(returns_rows(sql, SqlDriver::Pgx), want, "{sql:?}");
        }
    }
}

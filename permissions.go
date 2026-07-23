package main

import (
	"fmt"
	"strings"
)

// Op is a classified SQL operation (CRUD).
type Op string

const (
	OpRead   Op = "read"
	OpCreate Op = "create"
	OpUpdate Op = "update"
	OpDelete Op = "delete"
)

// PermSet is the set of operations the agent is allowed to perform.
type PermSet map[Op]bool

var allOps = []Op{OpRead, OpCreate, OpUpdate, OpDelete}

// ParsePerms parses a comma-separated permission list like "read,create".
// Empty input defaults to read-only. Unknown tokens are an error.
func ParsePerms(s string) (PermSet, error) {
	ps := PermSet{}
	for _, tok := range strings.Split(s, ",") {
		tok = strings.ToLower(strings.TrimSpace(tok))
		if tok == "" {
			continue
		}
		switch Op(tok) {
		case OpRead, OpCreate, OpUpdate, OpDelete:
			ps[Op(tok)] = true
		default:
			return nil, fmt.Errorf("unknown permission %q (valid: read, create, update, delete)", tok)
		}
	}
	if len(ps) == 0 {
		ps[OpRead] = true
	}
	return ps, nil
}

// String lists permitted ops in canonical order.
func (ps PermSet) String() string {
	var out []string
	for _, o := range allOps {
		if ps[o] {
			out = append(out, string(o))
		}
	}
	return strings.Join(out, ", ")
}

// Authorize classifies sql and verifies every operation it performs is
// allowed on the connection. It returns the operation(s) involved — more
// than one only for a data-modifying CTE (e.g. WITH x AS (DELETE ...
// RETURNING ...) INSERT ...). UPDATE/DELETE with no top-level WHERE clause
// is denied unless the connection sets allow_unfiltered_writes.
func Authorize(sql string, cfg *ConnConfig) ([]Op, error) {
	ops, unfiltered, err := classify(sql, cfg.SQLDriver)
	if err != nil {
		return nil, err
	}
	for _, op := range ops {
		if !cfg.Perms[op] {
			return nil, fmt.Errorf("operation %q is not permitted (allowed: %s)", op, cfg.Perms)
		}
	}
	if unfiltered && !cfg.AllowUnfilteredWrites {
		return nil, fmt.Errorf("UPDATE/DELETE without a WHERE clause is not permitted on this connection (set allow_unfiltered_writes to override)")
	}
	return ops, nil
}

func classify(sql, driver string) (ops []Op, unfiltered bool, err error) {
	scrubbed := scrub(sql, driver)
	if multiStatement(scrubbed) {
		return nil, false, fmt.Errorf("only one statement per call is allowed")
	}
	ops, unfiltered, err = classifyStmt(tokenize(scrubbed))
	if err != nil {
		return nil, false, err
	}
	return dedupeOps(ops), unfiltered, nil
}

// sqlToken is a word (uppercased) or one of the punctuation bytes '(' ')' ','.
type sqlToken struct {
	word string
	ch   byte
}

func isWordByte(c byte) bool {
	return c == '_' || c == '$' || c == '#' ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func tokenize(scrubbed string) []sqlToken {
	var toks []sqlToken
	for i := 0; i < len(scrubbed); {
		c := scrubbed[i]
		switch {
		case c == '(' || c == ')' || c == ',':
			toks = append(toks, sqlToken{ch: c})
			i++
		case isWordByte(c):
			j := i
			for j < len(scrubbed) && isWordByte(scrubbed[j]) {
				j++
			}
			toks = append(toks, sqlToken{word: strings.ToUpper(scrubbed[i:j])})
			i = j
		default:
			i++
		}
	}
	return toks
}

// classifyStmt classifies one statement scope by its leading verb. For WITH
// it recurses into every CTE body and the main statement, so a write verb
// only counts in verb position — never as an identifier.
func classifyStmt(toks []sqlToken) ([]Op, bool, error) {
	i := 0
	for i < len(toks) && toks[i].ch == '(' {
		i++
	}
	if i >= len(toks) || toks[i].word == "" {
		return nil, false, fmt.Errorf("empty statement")
	}
	rest := toks[i+1:]
	switch toks[i].word {
	case "SELECT", "VALUES", "TABLE":
		if hasScopeWord(rest, "INTO") {
			return nil, false, fmt.Errorf("SELECT ... INTO creates a table and is not permitted")
		}
		return []Op{OpRead}, false, nil
	case "INSERT":
		return []Op{OpCreate}, false, nil
	case "UPDATE":
		return []Op{OpUpdate}, !hasScopeWord(rest, "WHERE"), nil
	case "DELETE":
		return []Op{OpDelete}, !hasScopeWord(rest, "WHERE"), nil
	case "WITH":
		return classifyWith(rest)
	default:
		return nil, false, fmt.Errorf("statement type %q is not permitted; only SELECT, INSERT, UPDATE and DELETE are allowed", toks[i].word)
	}
}

// hasScopeWord reports whether word occurs at paren-depth 0 of this scope;
// scanning stops where the scope's parentheses close.
func hasScopeWord(toks []sqlToken, word string) bool {
	depth := 0
	for _, t := range toks {
		switch {
		case t.ch == '(':
			depth++
		case t.ch == ')':
			depth--
			if depth < 0 {
				return false
			}
		case depth == 0 && t.word == word:
			return true
		}
	}
	return false
}

var stmtKeywords = map[string]bool{
	"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"MERGE": true, "VALUES": true, "TABLE": true,
	"EXEC": true, "EXECUTE": true, "CALL": true,
}

// classifyWith walks a WITH clause at paren-depth 0. A '(' directly after
// AS / AS [NOT] MATERIALIZED opens a CTE body (recursed); the main statement
// is the first depth-0 statement keyword outside a body, or a bare '('
// directly following a body (parenthesised main statement). Anything else —
// no main statement, or a non-CRUD main verb — is an error, preserving
// default-deny.
func classifyWith(toks []sqlToken) ([]Op, bool, error) {
	var ops []Op
	var unfiltered bool
	depth := 0
	lastWord := "" // most recent depth-0 word, cleared at ',' and after a body
	bodySeen := false
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		switch {
		case t.ch == '(':
			if depth == 0 && (lastWord == "AS" || lastWord == "MATERIALIZED") {
				close := matchParen(toks, i)
				bOps, bUnf, err := classifyStmt(toks[i+1 : close])
				if err != nil {
					return nil, false, err
				}
				ops = append(ops, bOps...)
				unfiltered = unfiltered || bUnf
				bodySeen = true
				lastWord = ""
				i = close
				continue
			}
			if depth == 0 && bodySeen && lastWord == "" {
				// parenthesised main statement after the CTE list
				mOps, mUnf, err := classifyStmt(toks[i:])
				if err != nil {
					return nil, false, err
				}
				return append(ops, mOps...), unfiltered || mUnf, nil
			}
			depth++
		case t.ch == ')':
			depth--
		case t.ch == ',':
			if depth == 0 {
				lastWord = ""
			}
		case t.word != "" && depth == 0:
			if stmtKeywords[t.word] {
				mOps, mUnf, err := classifyStmt(toks[i:])
				if err != nil {
					return nil, false, err
				}
				return append(ops, mOps...), unfiltered || mUnf, nil
			}
			lastWord = t.word
		}
	}
	return nil, false, fmt.Errorf("could not find the main statement after WITH")
}

// matchParen returns the index of the ')' matching the '(' at open, or
// len(toks) when unbalanced.
func matchParen(toks []sqlToken, open int) int {
	depth := 0
	for i := open; i < len(toks); i++ {
		switch toks[i].ch {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return len(toks)
}

func dedupeOps(ops []Op) []Op {
	seen := map[Op]bool{}
	out := ops[:0]
	for _, o := range ops {
		if !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

// ReturnsRows reports whether the statement yields a result set, so the caller
// can pick Query (rows) over Exec (rows-affected).
func ReturnsRows(sql, driver string) bool {
	scrubbed := scrub(sql, driver)
	switch leadingKeyword(scrubbed) {
	case "SELECT", "WITH":
		return true
	}
	w := wordSet(scrubbed)
	return w["RETURNING"] || w["OUTPUT"]
}

// multiStatement reports whether scrubbed SQL holds more than one statement
// (any semicolon other than trailing ones).
func multiStatement(scrubbed string) bool {
	s := strings.TrimRight(strings.TrimSpace(scrubbed), "; \t\r\n")
	return strings.Contains(s, ";")
}

func leadingKeyword(scrubbed string) string {
	fields := strings.Fields(strings.TrimLeft(scrubbed, " \t\r\n("))
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}

func wordSet(scrubbed string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToUpper(scrubbed), func(r rune) bool {
		return !(r == '_' || r == '$' || r == '#' || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	}) {
		m[w] = true
	}
	return m
}

// scrub replaces comments and quoted literals/identifiers with spaces so that a
// semicolon or keyword hidden inside one cannot fool classification. It is a
// guard, not a full SQL parser — pair it with a least-privilege DB user.
// For postgres it also blanks $tag$...$tag$ dollar-quoted literals.
func scrub(sql, driver string) string {
	const (
		normal = iota
		lineComment
		blockComment
		single
		double
		bracket
		backtick
	)
	var b strings.Builder
	b.Grow(len(sql))
	state := normal
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		switch state {
		case normal:
			switch {
			case c == '$' && driver == "pgx":
				if end, ok := dollarQuoteEnd(sql, i); ok {
					b.WriteByte(' ')
					i = end
				} else {
					b.WriteByte(c)
				}
			case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
				state, i = lineComment, i+1
				b.WriteByte(' ')
			case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
				state, i = blockComment, i+1
				b.WriteByte(' ')
			case c == '\'':
				state = single
				b.WriteByte(' ')
			case c == '"':
				state = double
				b.WriteByte(' ')
			case c == '[':
				state = bracket
				b.WriteByte(' ')
			case c == '`':
				state = backtick
				b.WriteByte(' ')
			default:
				b.WriteByte(c)
			}
		case lineComment:
			if c == '\n' {
				state = normal
				b.WriteByte('\n')
			}
		case blockComment:
			if c == '*' && i+1 < len(sql) && sql[i+1] == '/' {
				state, i = normal, i+1
				b.WriteByte(' ')
			}
		case single:
			if c == '\'' {
				if i+1 < len(sql) && sql[i+1] == '\'' { // '' escape
					i++
				} else {
					state = normal
				}
			}
		case double:
			if c == '"' {
				if i+1 < len(sql) && sql[i+1] == '"' {
					i++
				} else {
					state = normal
				}
			}
		case bracket:
			if c == ']' {
				if i+1 < len(sql) && sql[i+1] == ']' {
					i++
				} else {
					state = normal
				}
			}
		case backtick:
			if c == '`' {
				if i+1 < len(sql) && sql[i+1] == '`' {
					i++
				} else {
					state = normal
				}
			}
		}
	}
	return b.String()
}

// dollarQuoteEnd parses a postgres dollar-quote delimiter ($$ or $tag$)
// starting at sql[i] == '$'. It returns the index of the closing
// delimiter's last byte — or the end of the string when unterminated — and
// whether a valid delimiter was found. Positional params like $1 do not
// match (tags cannot start with a digit).
func dollarQuoteEnd(sql string, i int) (int, bool) {
	j := i + 1
	for j < len(sql) && (sql[j] == '_' ||
		(sql[j] >= 'a' && sql[j] <= 'z') || (sql[j] >= 'A' && sql[j] <= 'Z') ||
		(sql[j] >= '0' && sql[j] <= '9')) {
		j++
	}
	if j >= len(sql) || sql[j] != '$' {
		return 0, false
	}
	if j > i+1 {
		c := sql[i+1]
		if !(c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return 0, false
		}
	}
	delim := sql[i : j+1]
	k := strings.Index(sql[j+1:], delim)
	if k < 0 {
		return len(sql) - 1, true
	}
	return j + 1 + k + len(delim) - 1, true
}

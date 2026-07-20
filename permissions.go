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

var writeVerbs = map[string]Op{
	"INSERT": OpCreate,
	"UPDATE": OpUpdate,
	"DELETE": OpDelete,
}

// Authorize classifies sql and verifies every operation it performs is allowed.
// It returns the operation(s) involved — more than one only for a
// data-modifying CTE (e.g. WITH x AS (DELETE ... RETURNING ...) INSERT ...).
func Authorize(sql string, allowed PermSet) ([]Op, error) {
	ops, err := classify(sql)
	if err != nil {
		return nil, err
	}
	for _, op := range ops {
		if !allowed[op] {
			return nil, fmt.Errorf("operation %q is not permitted (allowed: %s)", op, allowed)
		}
	}
	return ops, nil
}

func classify(sql string) ([]Op, error) {
	scrubbed := scrub(sql)
	if multiStatement(scrubbed) {
		return nil, fmt.Errorf("only one statement per call is allowed")
	}
	lead := leadingKeyword(scrubbed)
	if lead == "" {
		return nil, fmt.Errorf("empty statement")
	}
	switch lead {
	case "SELECT":
		if wordSet(scrubbed)["INTO"] {
			return nil, fmt.Errorf("SELECT ... INTO creates a table and is not permitted")
		}
		return []Op{OpRead}, nil
	case "WITH":
		words := wordSet(scrubbed)
		var found []Op
		for v, op := range writeVerbs {
			if words[v] {
				found = append(found, op)
			}
		}
		if len(found) == 0 {
			if words["INTO"] {
				return nil, fmt.Errorf("SELECT ... INTO creates a table and is not permitted")
			}
			return []Op{OpRead}, nil
		}
		return found, nil
	case "INSERT":
		return []Op{OpCreate}, nil
	case "UPDATE":
		return []Op{OpUpdate}, nil
	case "DELETE":
		return []Op{OpDelete}, nil
	default:
		return nil, fmt.Errorf("statement type %q is not permitted; only SELECT, INSERT, UPDATE and DELETE are allowed", lead)
	}
}

// ReturnsRows reports whether the statement yields a result set, so the caller
// can pick Query (rows) over Exec (rows-affected).
func ReturnsRows(sql string) bool {
	scrubbed := scrub(sql)
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
func scrub(sql string) string {
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

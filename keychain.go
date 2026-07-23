package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// runKeychainCLI implements `db-mcp keychain <add|update|list>`: an interactive
// helper that stores a connection's full DSN in the macOS login Keychain under
// the service name db-mcp/<connection>, which DB_DSN_CMD then reads at runtime.
// Only the DSN (the secret) lives in the Keychain — driver and permissions stay
// in the project's .mcp.json.
func runKeychainCLI(args []string) int {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	in := bufio.NewReader(os.Stdin)
	switch sub {
	case "add":
		return keychainStore(in, "")
	case "update":
		name, ok := pickConnection(in)
		if !ok {
			return 1
		}
		return keychainStore(in, name)
	case "list":
		names := listKeychainConns()
		if len(names) == 0 {
			fmt.Println("no db-mcp connections stored (add one with: db-mcp keychain add)")
			return 0
		}
		for _, n := range names {
			fmt.Println(n)
		}
		return 0
	default:
		fmt.Fprintln(os.Stderr, "usage: db-mcp keychain <add|update|list>")
		return 2
	}
}

// keychainStore prompts for every field, builds the DSN and writes it to the
// Keychain. presetName (set by `update`) skips the name prompt.
func keychainStore(in *bufio.Reader, presetName string) int {
	name := presetName
	if name == "" {
		name = promptRequired(in, "Connection name (stored as db-mcp/<name>)")
		if !validConnName(name) {
			fmt.Fprintln(os.Stderr, "invalid name: use letters, digits, dot, dash or underscore only")
			return 1
		}
	}
	driver := promptChoice(in, "Database type", []string{"postgres", "sqlserver", "oracle"})
	sqlDriver, _, defPort, ok := resolveDriver(driver)
	if !ok {
		fmt.Fprintln(os.Stderr, "unknown driver")
		return 1
	}
	host := promptRequired(in, "Host")
	port := promptPort(in, defPort)
	user := promptRequired(in, "User")
	pass, err := promptPassword(in, "Password")
	if err != nil {
		fmt.Fprintf(os.Stderr, "read password: %v\n", err)
		return 1
	}

	var dbName, sid string
	if sqlDriver == "oracle" {
		if svc := prompt(in, "Oracle service name (leave blank to connect by SID)", ""); svc != "" {
			dbName = svc
		} else {
			sid = promptRequired(in, "Oracle SID")
		}
	} else {
		dbName = promptRequired(in, "Database")
	}

	dsn, err := buildDSN(sqlDriver, host, port, user, pass, dbName, sid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build connection string: %v\n", err)
		return 1
	}
	if err := securityStore(name, dsn); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	// Verify the readback without ever printing the secret.
	if got, err := securityRead(name); err != nil || got != dsn {
		fmt.Fprintf(os.Stderr, "warning: stored, but readback verification failed: %v\n", err)
	}

	perms := prompt(in, "Permissions for the .mcp.json snippet (not stored in Keychain)", "read")
	verb := "Stored"
	if presetName != "" {
		verb = "Updated"
	}
	fmt.Printf("\n%s db-mcp/%s in the login Keychain.\n\n", verb, name)
	fmt.Print("Add this to the project's .mcp.json:\n\n")
	fmt.Printf("  \"env\": {\n    \"DB_DRIVER\": %q,\n    \"DB_PERMISSIONS\": %q,\n    \"DB_DSN_CMD\": \"security find-generic-password -s db-mcp/%s -w\"\n  }\n", driver, perms, name)
	return 0
}

// pickConnection lists the stored connections and returns the one the user
// selects by number or name.
func pickConnection(in *bufio.Reader) (string, bool) {
	names := listKeychainConns()
	if len(names) == 0 {
		fmt.Fprintln(os.Stderr, "no db-mcp connections stored yet (add one with: db-mcp keychain add)")
		return "", false
	}
	fmt.Fprintln(os.Stderr, "Stored connections:")
	for i, n := range names {
		fmt.Fprintf(os.Stderr, "  %d) %s\n", i+1, n)
	}
	sel := promptRequired(in, "Select a connection to update (number or name)")
	if i, err := strconv.Atoi(sel); err == nil && i >= 1 && i <= len(names) {
		return names[i-1], true
	}
	for _, n := range names {
		if n == sel {
			return n, true
		}
	}
	fmt.Fprintln(os.Stderr, "no such connection")
	return "", false
}

// securityStore writes (or updates, via -U) the DSN under db-mcp/<name>. The
// account attribute is the connection name so it stays stable across updates.
func securityStore(name, dsn string) error {
	cmd := exec.Command("security", "add-generic-password", "-U", "-s", "db-mcp/"+name, "-a", name, "-w", dsn)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("security add-generic-password: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func securityRead(name string) (string, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", "db-mcp/"+name, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

// listKeychainConns enumerates stored db-mcp/* connection names. It reads only
// item attributes (no -d), so it never triggers a Keychain access prompt.
func listKeychainConns() []string {
	out, _ := exec.Command("security", "dump-keychain").Output()
	return parseKeychainConns(string(out))
}

var svceRE = regexp.MustCompile(`"svce"<blob>="db-mcp/([^"]+)"`)

// parseKeychainConns extracts db-mcp/<name> service names from the output of
// `security dump-keychain`.
func parseKeychainConns(dump string) []string {
	seen := map[string]bool{}
	var names []string
	for _, m := range svceRE.FindAllStringSubmatch(dump, -1) {
		n := m[1]
		if validConnName(n) && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names
}

var connNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func validConnName(s string) bool { return connNameRE.MatchString(s) }

// --- prompting helpers (labels to stderr, so stdout carries only results) ---

func prompt(in *bufio.Reader, label, def string) string {
	if def != "" {
		fmt.Fprintf(os.Stderr, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(os.Stderr, "%s: ", label)
	}
	line, _ := in.ReadString('\n')
	if line = strings.TrimSpace(line); line == "" {
		return def
	}
	return line
}

func promptRequired(in *bufio.Reader, label string) string {
	for {
		if v := prompt(in, label, ""); v != "" {
			return v
		}
		fmt.Fprintln(os.Stderr, "required")
	}
}

func promptChoice(in *bufio.Reader, label string, opts []string) string {
	for {
		v := strings.ToLower(prompt(in, fmt.Sprintf("%s (%s)", label, strings.Join(opts, "/")), ""))
		for _, o := range opts {
			if v == o {
				return o
			}
		}
		fmt.Fprintf(os.Stderr, "please enter one of: %s\n", strings.Join(opts, ", "))
	}
}

func promptPort(in *bufio.Reader, def int) int {
	for {
		v := prompt(in, "Port", strconv.Itoa(def))
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		fmt.Fprintln(os.Stderr, "enter a positive port number")
	}
}

// promptPassword reads a line with terminal echo disabled. If stdin is not a
// tty (piped input), stty fails and the password is read normally.
func promptPassword(in *bufio.Reader, label string) (string, error) {
	fmt.Fprintf(os.Stderr, "%s: ", label)
	restore := disableEcho()
	line, err := in.ReadString('\n')
	restore()
	fmt.Fprintln(os.Stderr)
	if line == "" && err != nil {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func disableEcho() func() {
	set := func(arg string) {
		c := exec.Command("stty", arg)
		c.Stdin = os.Stdin
		c.Run()
	}
	set("-echo")
	return func() { set("echo") }
}

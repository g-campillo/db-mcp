//! Connection secrets in the macOS login Keychain. One item per connection:
//! service `db-mcp/<name>`, account `<name>`, and the full DSN as the secret,
//! which DB_DSN_CMD reads back at runtime.
//!
//! Only the DSN lives here; driver and permissions stay in the project's
//! .mcp.json, so the Keychain holds the secret and nothing else.
//!
//! Everything goes through the `security` command, as in the TypeScript
//! build, including how its failures are reported.

use std::collections::BTreeSet;
use std::io;
use std::process::{Command, Stdio};

use anyhow::{Result, anyhow, bail};

use crate::config::js_trim;

const SERVICE_PREFIX: &str = "db-mcp";

/// What precedes a name in `security dump-keychain` output.
const SVCE_MARKER: &str = "\"svce\"<blob>=\"db-mcp/";

/// The TypeScript build read the secret with Node's default output cap, and
/// treated anything longer as a failed read.
const READ_MAX_BYTES: usize = 1024 * 1024;

/// The output cap the TypeScript build gave `security dump-keychain`.
const DUMP_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Connection names are embedded in the service string, so keep them boring:
/// one or more letters, digits, dots, dashes or underscores.
pub fn valid_conn_name(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn invalid_name(name: &str) -> anyhow::Error {
    anyhow!("invalid name \"{name}\": use letters, digits, dot, dash or underscore only")
}

fn service(name: &str) -> Result<String> {
    if !valid_conn_name(name) {
        return Err(invalid_name(name));
    }
    Ok(format!("{SERVICE_PREFIX}/{name}"))
}

/// The service for a write or delete. The TypeScript build checked the name
/// inside the same try block as the command, so an invalid name was reported
/// as that command failing; this keeps the wording.
fn service_for(subcommand: &str, name: &str) -> Result<String> {
    service(name).map_err(|e| anyhow!("security {subcommand}: Error: {e}"))
}

/// Reads the stored DSN, or `None` when there is none. Every failure reads as
/// "none", an invalid name included, exactly as in the TypeScript build.
pub fn read_connection(name: &str) -> Option<String> {
    let service = service(name).ok()?;
    let out = Command::new("security")
        .args(["find-generic-password", "-s", &service, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.len() > READ_MAX_BYTES {
        return None;
    }
    let secret = String::from_utf8_lossy(&out.stdout);
    Some(secret.trim_end_matches(['\r', '\n']).to_owned())
}

/// Writes (or updates, via -U) the DSN. The account attribute is the
/// connection name so it stays stable across updates.
///
/// The secret is passed in argv, which is briefly visible to `ps` on this
/// machine: the same trade-off the earlier builds accepted for local dev
/// credentials.
pub fn write_connection(name: &str, dsn: &str) -> Result<()> {
    let subcommand = "add-generic-password";
    let service = service_for(subcommand, name)?;
    let args = [subcommand, "-U", "-s", &service, "-a", name, "-w"];
    // An error message must never carry the secret, so it shows a placeholder.
    run_security(
        &[&args[..], &[dsn]].concat(),
        &[&args[..], &["<dsn>"]].concat(),
    )
}

/// Removes a stored connection.
pub fn delete_connection(name: &str) -> Result<()> {
    let subcommand = "delete-generic-password";
    let service = service_for(subcommand, name)?;
    let args = [subcommand, "-s", &service];
    run_security(&args, &args)
}

/// Runs `security` for its effect. A failure becomes
/// `security <subcommand>: <reason>`, where the reason is what `security`
/// wrote to stderr or, when it wrote nothing, Node's description of the
/// failure. `shown` is the argument list to use in that description.
fn run_security(args: &[&str], shown: &[&str]) -> Result<()> {
    let output = Command::new("security")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    let reason = match output {
        Ok(out) if out.status.success() => return Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            match js_trim(&stderr) {
                "" => format!("Error: Command failed: security {}", shown.join(" ")),
                text => text.to_owned(),
            }
        }
        Err(e) => format!("Error: spawnSync security {}", spawn_error_code(&e)),
    };
    bail!("security {}: {reason}", args[0])
}

/// The code Node names a failed spawn by, for the failures that can happen
/// here; anything else is described in the operating system's words.
fn spawn_error_code(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT".to_owned(),
        io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
        _ => e.to_string(),
    }
}

/// Enumerates stored db-mcp/* connection names, sorted. Reads only item
/// attributes (no -d), so it never triggers a Keychain access prompt. Any
/// failure gives an empty list.
pub fn list_connections() -> Vec<String> {
    let Ok(out) = Command::new("security")
        .arg("dump-keychain")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() || out.stdout.len() > DUMP_MAX_BYTES {
        return Vec::new();
    }
    parse_keychain_conns(&String::from_utf8_lossy(&out.stdout))
}

/// Extracts db-mcp/<name> service names from `security dump-keychain` output:
/// every `"svce"<blob>="db-mcp/<name>"` whose name is valid, deduplicated and
/// sorted. Scans the way the TypeScript's global regex did, so overlapping and
/// malformed entries resolve the same way.
pub fn parse_keychain_conns(dump: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut rest = dump;
    while let Some(start) = rest.find(SVCE_MARKER) {
        let after = &rest[start + SVCE_MARKER.len()..];
        // Every later marker contains a quote, so with none left, nothing is.
        let Some(end) = after.find('"') else {
            break;
        };
        let name = &after[..end];
        if name.is_empty() {
            // No match here; the next one may begin at this very quote.
            rest = after;
            continue;
        }
        if valid_conn_name(name) {
            names.insert(name.to_owned());
        }
        rest = &after[end + 1..];
    }
    names.into_iter().collect()
}

/// Moves a stored connection to a new name. `security` has no rename, so this
/// copies the secret across and then removes the original, and verifies the
/// copy landed before deleting anything.
pub fn rename_connection(from: &str, to: &str) -> Result<()> {
    if !valid_conn_name(to) {
        return Err(invalid_name(to));
    }
    if from == to {
        bail!("the new name is the same as the old one");
    }

    let Some(dsn) = read_connection(from) else {
        bail!("no stored connection named \"{from}\" (list them with: db-mcp keychain list)");
    };
    if read_connection(to).is_some() {
        bail!("\"{to}\" already exists — pick another name or delete it first");
    }

    write_connection(to, &dsn)?;
    // Only drop the original once the copy reads back intact.
    if read_connection(to).as_deref() != Some(dsn.as_str()) {
        bail!("copy to \"{to}\" could not be verified; the original was left in place");
    }
    delete_connection(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    // parse_keychain_conns

    #[test]
    fn returns_sorted_deduped_db_mcp_names_and_ignores_other_services() {
        let dump = r#"
keychain: "/Users/x/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
    "acct"<blob>="navy-dev"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/ah-product"
    "acct"<blob>="ah-product"
class: "genp"
attributes:
    "svce"<blob>="some-other-service"
    "acct"<blob>="me"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
"#;
        assert_eq!(parse_keychain_conns(dump), ["ah-product", "navy-dev"]);
    }

    #[test]
    fn returns_nothing_for_an_empty_dump() {
        assert!(parse_keychain_conns("").is_empty());
    }

    #[test]
    fn skips_names_that_fail_validation() {
        assert!(parse_keychain_conns(r#""svce"<blob>="db-mcp/has space""#).is_empty());
    }

    /// Edge cases of the hand-written scan; the expected values come from the
    /// TypeScript's regex.
    #[test]
    fn scans_malformed_dumps_like_the_typescript_regex() {
        let cases: [(&str, &[&str]); 6] = [
            // An empty name is no match, and the next marker may start at its quote.
            (r#""svce"<blob>="db-mcp/""svce"<blob>="db-mcp/b""#, &["b"]),
            // A match consumes its closing quote, which then can't open another.
            (r#""svce"<blob>="db-mcp/a"svce"<blob>="db-mcp/b""#, &["a"]),
            // No closing quote, no match.
            (r#""svce"<blob>="db-mcp/abc"#, &[]),
            // A name runs to the next quote, across lines, then fails validation.
            ("\"svce\"<blob>=\"db-mcp/a\nb\"", &[]),
            (r#""svce"<blob>="db-mcp/a/b""#, &[]),
            (
                r#""svce"<blob>="db-mcp/Z""svce"<blob>="db-mcp/A.b_c-9""#,
                &["A.b_c-9", "Z"],
            ),
        ];
        for (dump, want) in cases {
            assert_eq!(parse_keychain_conns(dump), want, "{dump:?}");
        }
    }

    // valid_conn_name

    #[test]
    fn accepts() {
        for s in ["navy-dev", "ah_product", "db.one", "A1"] {
            assert!(valid_conn_name(s), "{s:?}");
        }
    }

    #[test]
    fn rejects() {
        for s in ["", "has space", "with/slash", "a;b", "quote\""] {
            assert!(!valid_conn_name(s), "{s:?}");
        }
    }

    // Invalid names never reach `security`, so these touch no Keychain.

    #[test]
    fn invalid_names_fail_with_the_typescript_wording() {
        assert_eq!(read_connection("has space"), None);
        assert_eq!(
            write_connection("has space", "dsn")
                .unwrap_err()
                .to_string(),
            "security add-generic-password: Error: invalid name \"has space\": use letters, digits, dot, dash or underscore only"
        );
        assert_eq!(
            delete_connection("a;b").unwrap_err().to_string(),
            "security delete-generic-password: Error: invalid name \"a;b\": use letters, digits, dot, dash or underscore only"
        );
    }

    #[test]
    fn rename_checks_names_before_touching_the_keychain() {
        let message = |from: &str, to: &str| rename_connection(from, to).unwrap_err().to_string();
        assert_eq!(
            message("a", "with/slash"),
            "invalid name \"with/slash\": use letters, digits, dot, dash or underscore only"
        );
        assert_eq!(
            message("same", "same"),
            "the new name is the same as the old one"
        );
        assert_eq!(
            message("has space", "ok"),
            "no stored connection named \"has space\" (list them with: db-mcp keychain list)"
        );
    }

    /// Deletes the throwaway items however the test ends, so a failed
    /// assertion cannot leave anything behind in the login Keychain.
    struct Cleanup<'a>(&'a [&'a str]);

    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            for name in self.0 {
                let _ = delete_connection(name);
            }
        }
    }

    #[test]
    #[ignore = "writes to the login Keychain; run with: cargo test keychain:: -- --ignored"]
    fn live_round_trip() {
        let name = format!("zz-rust-selftest-{}", std::process::id());
        let renamed = format!("{name}-renamed");
        let names = [name.as_str(), renamed.as_str()];
        let _cleanup = Cleanup(&names);
        let dsn = "postgres://u:p%40ss w@h:5432/db?sslmode=disable";

        assert_eq!(read_connection(&name), None);
        write_connection(&name, "first").unwrap();
        write_connection(&name, dsn).unwrap(); // -U updates in place
        assert_eq!(read_connection(&name).as_deref(), Some(dsn));
        assert!(list_connections().contains(&name));

        rename_connection(&name, &renamed).unwrap();
        assert_eq!(read_connection(&name), None);
        assert_eq!(read_connection(&renamed).as_deref(), Some(dsn));

        delete_connection(&renamed).unwrap();
        assert_eq!(read_connection(&renamed), None);
        let listed = list_connections();
        assert!(
            !listed.contains(&name) && !listed.contains(&renamed),
            "{listed:?}"
        );

        // A missing item is reported in security's own words.
        let err = delete_connection(&renamed).unwrap_err().to_string();
        assert!(
            err.starts_with("security delete-generic-password: security: "),
            "{err}"
        );
    }
}

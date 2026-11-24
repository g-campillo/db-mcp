//! The audit log: one JSON line per agent-authored statement (the `query` and
//! `explain` tools). Introspection tools run fixed catalog SQL and are not
//! audited; neither are authorization denials, since nothing was executed.

use std::fs::{DirBuilder, OpenOptions};
use std::io::{self, Write as _};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Result, anyhow};
use serde::Serialize;

use crate::config::{js_trim, parse_go_bool};
use crate::paths::app_config_dir;

/// One audited statement.
///
/// Fields are written in declaration order, the order the TypeScript build
/// wrote them in, and a `None` field is left out of the line entirely.
#[derive(Debug, Clone, Serialize)]
pub struct AuditRecord<'a> {
    pub connection: &'a str,
    pub tool: &'a str,
    pub op: &'a str,
    pub sql: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}

/// What goes on disk: the record's own fields, then `ts` last.
#[derive(Serialize)]
struct Line<'a> {
    #[serde(flatten)]
    record: &'a AuditRecord<'a>,
    ts: String,
}

/// Appends audit records to a JSONL file.
///
/// The file is reopened for every record, so when external tooling renames or
/// deletes it to rotate it, the next record starts a fresh file rather than
/// following the old one. Each line goes out in one append, which keeps
/// records whole and in order. There is no rotation and no per-line fsync.
#[derive(Debug)]
pub struct Auditor {
    path: PathBuf,
}

impl Auditor {
    /// Opens (or creates) the audit log, by default
    /// `<user config dir>/db-mcp/audit.jsonl`; DB_AUDIT_PATH overrides it.
    /// Returns `None` when DB_AUDIT_DISABLED is true. Failing to create the
    /// directory or the file is an error, because a safety feature that
    /// silently does nothing is worse than a crash at startup.
    ///
    /// `env` returns a variable's value, or `None` when it is unset. The
    /// default location still comes from this process's HOME, as it did in the
    /// TypeScript build.
    pub fn open(env: impl Fn(&str) -> Option<String>) -> Result<Option<Auditor>> {
        // Only a valid true disables auditing; a typo such as "yes" leaves it on.
        let disabled = env("DB_AUDIT_DISABLED").unwrap_or_default();
        if parse_go_bool(js_trim(&disabled)) == Some(true) {
            return Ok(None);
        }

        let configured = env("DB_AUDIT_PATH").unwrap_or_default();
        let configured = js_trim(&configured);
        let path = if configured.is_empty() {
            app_config_dir()?.join("audit.jsonl")
        } else {
            PathBuf::from(configured)
        };

        // A bare file name has an empty parent: the current directory, which exists.
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            create_dir_all(dir).map_err(|e| anyhow!("{e}, mkdir '{}'", dir.display()))?;
        }
        // Create the file now so a permission problem surfaces at startup, not mid-query.
        append(&path, b"")?;
        Ok(Some(Auditor { path }))
    }

    /// `open` over this process's environment. A variable that is not valid
    /// Unicode counts as unset.
    pub fn open_from_env() -> Result<Option<Auditor>> {
        Self::open(|k| std::env::var(k).ok())
    }

    /// Appends one record stamped with the current time. A failure is reported
    /// on stderr, never stdout, because stdout carries the MCP protocol stream;
    /// and it is never a panic, because losing one audit line must not take
    /// the server down.
    pub fn log(&self, record: &AuditRecord) {
        if let Err(err) = self.write(record, SystemTime::now()) {
            let _ = writeln!(io::stderr(), "db-mcp: audit: write: {err}");
        }
    }

    fn write(&self, record: &AuditRecord, now: SystemTime) -> Result<()> {
        append(&self.path, &line(record, now)?)
    }
}

/// The line for `record` at `now`, newline included. `ts` has the format of
/// JavaScript's Date.toISOString: UTC, milliseconds, and a trailing Z.
fn line(record: &AuditRecord, now: SystemTime) -> Result<Vec<u8>> {
    let ts = humantime::format_rfc3339_millis(now).to_string();
    let mut bytes = serde_json::to_vec(&Line { record, ts })?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Appends `bytes` with a single write, creating the file with mode 0600 if
/// it is missing. Errors name the step and path in the order Node used.
fn append(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|e| anyhow!("{e}, open '{}'", path.display()))?;
    file.write_all(bytes).map_err(|e| anyhow!("{e}, write"))
}

/// Creates `dir` and any missing parents with mode 0755.
fn create_dir_all(dir: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o755);
    builder.create(dir)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    /// Only the given variables are visible, so the real environment can't
    /// leak in.
    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn open_at(path: &Path) -> Auditor {
        let path = path.to_str().unwrap();
        Auditor::open(env_of(&[("DB_AUDIT_PATH", path)]))
            .unwrap()
            .expect("auditing is enabled")
    }

    fn at_millis(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    fn record(sql: &str) -> AuditRecord<'_> {
        AuditRecord {
            connection: "default",
            tool: "query",
            op: "read",
            sql,
            rows: Some(1),
            rows_affected: None,
            duration_ms: 5,
            error: None,
        }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// Both lines were written by the TypeScript Auditor at the same instants.
    #[test]
    fn lines_match_the_typescript_byte_for_byte() {
        let mut sql: String = (0u8..128).map(char::from).collect();
        sql.push_str("\u{e9}\u{20ac}\u{1f600}\u{2028}\u{2029}\u{feff}");
        let first = AuditRecord {
            connection: "default",
            tool: "query",
            op: "read",
            sql: &sql,
            rows: Some(3),
            rows_affected: None,
            duration_ms: 12,
            error: None,
        };
        let second = AuditRecord {
            connection: "default",
            tool: "explain",
            op: "update,delete",
            sql: "x",
            rows: None,
            rows_affected: Some(7),
            duration_ms: 0,
            error: Some("boom \"q\" \\ \u{e9}"),
        };

        assert_eq!(
            String::from_utf8(line(&first, at_millis(1_795_541_605_946)).unwrap()).unwrap(),
            "{\"connection\":\"default\",\"tool\":\"query\",\"op\":\"read\",\"sql\":\"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f !\\\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u{7f}\u{e9}\u{20ac}\u{1f600}\u{2028}\u{2029}\u{feff}\",\"rows\":3,\"duration_ms\":12,\"ts\":\"2026-11-24T17:33:25.946Z\"}\n"
        );
        assert_eq!(
            String::from_utf8(line(&second, at_millis(1_795_541_605_947)).unwrap()).unwrap(),
            "{\"connection\":\"default\",\"tool\":\"explain\",\"op\":\"update,delete\",\"sql\":\"x\",\"rows_affected\":7,\"duration_ms\":0,\"error\":\"boom \\\"q\\\" \\\\ \u{e9}\",\"ts\":\"2026-11-24T17:33:25.947Z\"}\n"
        );
    }

    /// Date.now() counts whole milliseconds, so anything finer is dropped,
    /// never rounded up.
    #[test]
    fn ts_has_the_to_iso_string_format() {
        let ts = |t: SystemTime| {
            let bytes = line(&record("x"), t).unwrap();
            let text = String::from_utf8(bytes).unwrap();
            let start = text.find("\"ts\":\"").unwrap() + 6;
            text[start..start + 24].to_owned()
        };
        assert_eq!(ts(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            ts(at_millis(1_795_541_605_946) + Duration::from_nanos(999_999)),
            "2026-11-24T17:33:25.946Z"
        );
    }

    #[test]
    fn disabled_only_by_a_valid_true() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let path_text = path.to_str().unwrap();
        for value in ["true", "1", "T", " TRUE\t", "\u{feff}true"] {
            let env = env_of(&[("DB_AUDIT_DISABLED", value), ("DB_AUDIT_PATH", path_text)]);
            assert!(Auditor::open(env).unwrap().is_none(), "{value:?}");
        }
        assert!(
            !path.exists(),
            "a disabled auditor must not create the file"
        );

        // JavaScript's trim keeps U+0085, so that value is not a valid bool.
        for value in ["", "false", "0", "yes", "on", "\u{85}true"] {
            let env = env_of(&[("DB_AUDIT_DISABLED", value), ("DB_AUDIT_PATH", path_text)]);
            assert!(Auditor::open(env).unwrap().is_some(), "{value:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn open_creates_the_directories_and_an_empty_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b");
        let path = nested.join("audit.jsonl");
        open_at(&path);

        assert_eq!(fs::read(&path).unwrap(), b"");
        assert_eq!(mode(&path), 0o600);
        // 0755 less whatever the umask removes.
        assert_eq!(mode(&nested) & !0o755, 0);
        assert_eq!(mode(&dir.path().join("a")) & !0o755, 0);
    }

    #[test]
    fn open_trims_the_configured_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let padded = format!(" {}\u{feff}\n", path.display());
        let env = env_of(&[("DB_AUDIT_PATH", padded.as_str())]);
        Auditor::open(env).unwrap().unwrap();
        assert!(path.exists());
    }

    #[test]
    fn open_fails_when_the_directory_cannot_be_made() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        fs::write(&blocker, "").unwrap();
        let path = blocker.join("audit.jsonl");

        let env = env_of(&[("DB_AUDIT_PATH", path.to_str().unwrap())]);
        let err = Auditor::open(env).unwrap_err().to_string();
        assert!(
            err.ends_with(&format!(", mkdir '{}'", blocker.display())),
            "{err}"
        );
    }

    #[test]
    fn log_appends_one_line_per_record_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let auditor = open_at(&path);
        auditor.log(&record("select 1"));
        auditor.log(&record("select 2"));

        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"sql\":\"select 1\""), "{}", lines[0]);
        assert!(lines[1].contains("\"sql\":\"select 2\""), "{}", lines[1]);
        assert!(text.ends_with('\n'));
    }

    /// Rotation tools rename the file away; the next record must start a new
    /// file rather than land in the renamed one.
    #[cfg(unix)]
    #[test]
    fn log_starts_a_new_file_after_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let rotated = dir.path().join("audit.jsonl.1");
        let auditor = open_at(&path);
        auditor.log(&record("before"));
        fs::rename(&path, &rotated).unwrap();
        auditor.log(&record("after"));

        let old = fs::read_to_string(&rotated).unwrap();
        let new = fs::read_to_string(&path).unwrap();
        assert!(old.contains("before") && !old.contains("after"), "{old}");
        assert!(new.contains("after") && !new.contains("before"), "{new}");
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn a_failed_write_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let auditor = open_at(&path);
        // Something replaced the log with a directory: the next open fails.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        let err = auditor.write(&record("x"), SystemTime::now()).unwrap_err();
        assert!(
            err.to_string()
                .ends_with(&format!(", open '{}'", path.display())),
            "{err}"
        );
        auditor.log(&record("x")); // reported on stderr; must not panic
    }
}

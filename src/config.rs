//! The one database connection this process serves, built from the DB_*
//! environment variables set in the project's local .mcp.json.
//!
//! There is no machine-global config file: a project reaches exactly the
//! database its own .mcp.json names, and nothing else.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Result, bail};

use crate::drivers::{SqlDriver, resolve_driver};
use crate::duration::parse_go_duration;
use crate::paths::app_config_dir;
use crate::permissions::{PermSet, parse_perms};

/// The resolved connection config.
///
/// Deliberately not `Debug`: it holds the password, and a type that cannot be
/// printed with `{:?}` cannot leak it into a log or a panic message.
#[derive(Clone)]
pub struct ResolvedConfig {
    pub name: String,
    /// DB_DRIVER as given, trimmed.
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub password_cmd: String,
    pub database: String,
    pub oracle_sid: String,
    /// Full driver-native connection string; bypasses `build_dsn`.
    pub dsn: String,
    /// Command whose stdout is the full DSN (e.g. macOS Keychain).
    pub dsn_cmd: String,
    pub allow_unfiltered_writes: bool,
    pub max_rows: usize,
    pub max_cell_bytes: usize,
    /// 0 disables the result byte cap.
    pub max_result_bytes: usize,

    pub sql_driver: SqlDriver,
    pub display_name: &'static str,
    pub perms: PermSet,
    pub timeout: Duration,
}

/// Builds the connection config from environment lookups. Never touches the
/// network or the Keychain: DB_DSN_CMD is resolved lazily on first use, so a
/// database being unreachable can't fail startup.
///
/// `env` returns a variable's value, or `None` when it is unset. Tests pass a
/// fixed map, so the ambient environment cannot leak in.
pub fn load_config(env: impl Fn(&str) -> Option<String>) -> Result<ResolvedConfig> {
    let raw = |k: &str| env(k).unwrap_or_default();
    let trimmed = |k: &str| js_trim(&raw(k)).to_owned();

    let driver = trimmed("DB_DRIVER");
    if driver.is_empty() {
        bail!(
            "no database configured: set DB_DRIVER plus either DB_DSN_CMD (a command yielding the full connection string) or DB_HOST/DB_USER/DB_NAME in this project's .mcp.json env"
        );
    }
    let Some(info) = resolve_driver(&driver) else {
        bail!("unsupported driver \"{driver}\" (use postgres, sqlserver or oracle)");
    };

    let dsn = trimmed("DB_DSN");
    let dsn_cmd = trimmed("DB_DSN_CMD");
    let password = raw("DB_PASSWORD"); // never trim a password
    let password_cmd = trimmed("DB_PASSWORD_CMD");
    let mut host = trimmed("DB_HOST");
    let mut user = trimmed("DB_USER");
    let database = trimmed("DB_NAME");
    let oracle_sid = trimmed("DB_ORACLE_SID");

    let mut port: u16 = 0;
    let port_text = trimmed("DB_PORT");
    if !port_text.is_empty() {
        port = match port_text.parse::<u16>() {
            Ok(p) if p > 0 => p,
            _ => bail!("invalid DB_PORT \"{port_text}\""),
        };
    }

    let mut max_rows: usize = 500;
    let max_rows_text = trimmed("DB_MAX_ROWS");
    if !max_rows_text.is_empty() {
        max_rows = match max_rows_text.parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => bail!("invalid DB_MAX_ROWS \"{max_rows_text}\""),
        };
    }

    let mut allow_unfiltered_writes = false;
    let allow_text = trimmed("DB_ALLOW_UNFILTERED_WRITES");
    if !allow_text.is_empty() {
        let Some(allow) = parse_go_bool(&allow_text) else {
            bail!("invalid DB_ALLOW_UNFILTERED_WRITES \"{allow_text}\" (use true/false)");
        };
        allow_unfiltered_writes = allow;
    }

    // In DSN mode the connection string carries host/user/credentials, so the
    // discrete fields are not required.
    let dsn_mode = !dsn.is_empty() || !dsn_cmd.is_empty();
    if dsn_mode {
        if !dsn.is_empty() && !dsn_cmd.is_empty() {
            bail!("DB_DSN and DB_DSN_CMD are mutually exclusive");
        }
        if !password.is_empty() || !password_cmd.is_empty() {
            bail!(
                "DB_DSN/DB_DSN_CMD carry the credentials, so cannot be combined with DB_PASSWORD/DB_PASSWORD_CMD"
            );
        }
    } else {
        if host.is_empty() {
            bail!("host is required (set DB_HOST, or use DB_DSN_CMD)");
        }
        if user.is_empty() {
            bail!("user is required (set DB_USER, or use DB_DSN_CMD)");
        }
        if port == 0 {
            port = info.default_port;
        }
        if !password.is_empty() && !password_cmd.is_empty() {
            bail!("DB_PASSWORD and DB_PASSWORD_CMD are mutually exclusive");
        }
        match info.sql_driver {
            SqlDriver::Pgx | SqlDriver::SqlServer => {
                if database.is_empty() {
                    bail!(
                        "database is required for {} (set DB_NAME)",
                        info.display_name
                    );
                }
            }
            SqlDriver::Oracle => {
                if database.is_empty() == oracle_sid.is_empty() {
                    bail!("oracle requires exactly one of DB_NAME (service name) or DB_ORACLE_SID");
                }
            }
        }
    }

    let perms = parse_perms(&raw("DB_PERMISSIONS"))?;

    let mut timeout = Duration::from_secs(30);
    let timeout_text = trimmed("DB_QUERY_TIMEOUT");
    if !timeout_text.is_empty() {
        let parsed = parse_go_duration(&timeout_text)
            .ok()
            .filter(|ms| ms.is_finite() && *ms > 0.0)
            .and_then(|ms| Duration::try_from_secs_f64(ms / 1000.0).ok());
        let Some(parsed) = parsed else {
            bail!("invalid query_timeout \"{timeout_text}\" (use a Go duration like 30s)");
        };
        timeout = parsed;
    }

    // DSN mode leaves the discrete fields empty; they are informational only.
    if dsn_mode {
        host.clear();
        user.clear();
    }

    Ok(ResolvedConfig {
        name: "default".to_owned(),
        driver,
        host,
        port,
        user,
        password,
        password_cmd,
        database,
        oracle_sid,
        dsn,
        dsn_cmd,
        allow_unfiltered_writes,
        max_rows,
        max_cell_bytes: 8192,
        max_result_bytes: 0,
        sql_driver: info.sql_driver,
        display_name: info.display_name,
        perms,
        timeout,
    })
}

/// `load_config` over this process's environment. A variable that is not valid
/// Unicode counts as unset.
pub fn load_config_from_env() -> Result<ResolvedConfig> {
    load_config(|k| std::env::var(k).ok())
}

/// Nags once on stderr if the retired machine-global config file is still on
/// disk. It is no longer read: that ambient file let any project reach every
/// connection listed in it. Credentials now live per-project in .mcp.json env
/// plus the macOS Keychain.
pub fn warn_stale_global_config() {
    // No config directory means there can be no stale file in it either.
    let Ok(dir) = app_config_dir() else {
        return;
    };
    if let Some(warning) = stale_global_config_warning(&dir) {
        // A warning that cannot be written must not stop the server, and
        // eprint! would panic on a closed stderr.
        let _ = std::io::stderr().write_all(warning.as_bytes());
    }
}

/// The warning line, newline included, when `<app_dir>/config.json` exists.
fn stale_global_config_warning(app_dir: &Path) -> Option<String> {
    let path = app_dir.join("config.json");
    path.exists().then(|| {
        format!(
            "db-mcp: warning: {} is no longer read; move each project's connection into its .mcp.json env (DB_DRIVER + DB_PERMISSIONS + DB_DSN_CMD) and delete this file\n",
            path.display()
        )
    })
}

/// Go's strconv.ParseBool accepts these spellings and nothing else.
pub(crate) fn parse_go_bool(s: &str) -> Option<bool> {
    match s {
        "1" | "t" | "T" | "true" | "TRUE" | "True" => Some(true),
        "0" | "f" | "F" | "false" | "FALSE" | "False" => Some(false),
        _ => None,
    }
}

/// Trims what JavaScript's String.prototype.trim trims, so values are cut
/// exactly as the TypeScript build cut them. That set is Unicode White_Space
/// (what `str::trim` uses) minus U+0085 NEXT LINE, plus U+FEFF, the byte
/// order mark.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::permissions::Op;

    /// Only the given DB_* vars are visible, so the ambient environment can't
    /// leak in.
    fn load(vars: &[(&str, &str)]) -> Result<ResolvedConfig> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        load_config(|k| map.get(k).cloned())
    }

    fn set(ops: &[Op]) -> PermSet {
        ops.iter().copied().collect()
    }

    /// One environment variable: (name, value).
    type Var = (&'static str, &'static str);

    #[test]
    fn resolves_discrete_field_mode() {
        let c = load(&[
            ("DB_DRIVER", "postgres"),
            ("DB_HOST", "envhost"),
            ("DB_USER", "envuser"),
            ("DB_PASSWORD", "trailing space "), // passwords are never trimmed
            ("DB_NAME", "envdb"),
            ("DB_PERMISSIONS", "read,create"),
            ("DB_MAX_ROWS", "42"),
        ])
        .unwrap();
        assert_eq!(c.name, "default");
        assert_eq!(c.sql_driver, SqlDriver::Pgx);
        assert_eq!(c.display_name, "postgres");
        assert_eq!(c.host, "envhost");
        assert_eq!(c.port, 5432);
        assert_eq!(c.password, "trailing space ");
        assert_eq!(c.perms, set(&[Op::Create, Op::Read]));
        assert_eq!(c.max_rows, 42);
        assert_eq!(c.timeout, Duration::from_secs(30));
        assert_eq!(c.max_cell_bytes, 8192);
    }

    #[test]
    fn defaults_to_read_only_with_a_500_row_cap() {
        let c = load(&[
            ("DB_DRIVER", "postgres"),
            ("DB_HOST", "h"),
            ("DB_USER", "u"),
            ("DB_NAME", "d"),
        ])
        .unwrap();
        assert_eq!(c.perms, set(&[Op::Read]));
        assert_eq!(c.max_rows, 500);
        assert!(!c.allow_unfiltered_writes);
    }

    #[test]
    fn accepts_every_driver_alias() {
        let cases = [
            ("postgres", SqlDriver::Pgx, 5432),
            ("postgresql", SqlDriver::Pgx, 5432),
            ("sqlserver", SqlDriver::SqlServer, 1433),
            ("mssql", SqlDriver::SqlServer, 1433),
            ("oracle", SqlDriver::Oracle, 1521),
        ];
        for (alias, sql_driver, default_port) in cases {
            let target = if alias == "oracle" {
                ("DB_ORACLE_SID", "X")
            } else {
                ("DB_NAME", "d")
            };
            let c = load(&[
                ("DB_DRIVER", alias),
                ("DB_HOST", "h"),
                ("DB_USER", "u"),
                target,
            ])
            .unwrap_or_else(|err| panic!("{alias}: {err}"));
            assert_eq!(c.sql_driver, sql_driver, "{alias}");
            assert_eq!(c.port, default_port, "{alias}");
        }
    }

    #[test]
    fn accepts_dsn_mode_without_discrete_fields() {
        let c = load(&[
            ("DB_DRIVER", "postgres"),
            ("DB_DSN", "postgres://u:p@h:5432/d"),
            ("DB_PERMISSIONS", "read"),
        ])
        .unwrap();
        assert_eq!(c.dsn, "postgres://u:p@h:5432/d");
        assert_eq!(c.sql_driver, SqlDriver::Pgx);
        assert_eq!(c.host, "");
    }

    #[test]
    fn keeps_db_dsn_cmd_unresolved_at_load_time() {
        // The command is NOT run at config-load time, so an arbitrary command
        // still resolves the config cleanly.
        let c = load(&[
            ("DB_DRIVER", "oracle"),
            (
                "DB_DSN_CMD",
                "security find-generic-password -s db-mcp/ora -w",
            ),
            ("DB_PERMISSIONS", "read,create,update,delete"),
        ])
        .unwrap();
        assert!(!c.dsn_cmd.is_empty());
        assert!(c.perms.contains(&Op::Delete));
    }

    #[test]
    fn parses_db_allow_unfiltered_writes() {
        let c = load(&[
            ("DB_DRIVER", "postgres"),
            ("DB_DSN", "postgres://u:p@h:5432/d"),
            ("DB_ALLOW_UNFILTERED_WRITES", "true"),
        ])
        .unwrap();
        assert!(c.allow_unfiltered_writes);
    }

    #[test]
    fn parses_go_durations_in_db_query_timeout() {
        let cases = [("30s", 30_000), ("1m30s", 90_000), ("500ms", 500)];
        for (text, want_ms) in cases {
            let c = load(&[
                ("DB_DRIVER", "postgres"),
                ("DB_DSN", "postgres://u:p@h/d"),
                ("DB_QUERY_TIMEOUT", text),
            ])
            .unwrap_or_else(|err| panic!("{text}: {err}"));
            assert_eq!(c.timeout, Duration::from_millis(want_ms), "{text}");
        }
    }

    #[test]
    fn rejects_invalid_configs() {
        let pg = [
            ("DB_DRIVER", "postgres"),
            ("DB_HOST", "h"),
            ("DB_USER", "u"),
        ];
        let pg_db = [
            ("DB_DRIVER", "postgres"),
            ("DB_HOST", "h"),
            ("DB_USER", "u"),
            ("DB_NAME", "d"),
        ];
        let pg_dsn = [("DB_DRIVER", "postgres"), ("DB_DSN", "postgres://u:p@h/d")];
        let with = |base: &[Var], extra: &[Var]| [base, extra].concat();

        // (label, vars, lower-cased text the error must contain)
        let cases: Vec<(&str, Vec<Var>, &str)> = vec![
            ("missing driver", vec![], "db_driver"),
            (
                "bad driver",
                vec![
                    ("DB_DRIVER", "mysql"),
                    ("DB_HOST", "h"),
                    ("DB_USER", "u"),
                    ("DB_NAME", "d"),
                ],
                "driver",
            ),
            (
                "discrete missing host",
                vec![
                    ("DB_DRIVER", "postgres"),
                    ("DB_USER", "u"),
                    ("DB_NAME", "d"),
                ],
                "host",
            ),
            (
                "discrete missing user",
                vec![
                    ("DB_DRIVER", "postgres"),
                    ("DB_HOST", "h"),
                    ("DB_NAME", "d"),
                ],
                "user",
            ),
            ("pg missing database", pg.to_vec(), "database"),
            (
                "oracle no db no sid",
                vec![("DB_DRIVER", "oracle"), ("DB_HOST", "h"), ("DB_USER", "u")],
                "oracle",
            ),
            (
                "oracle both db and sid",
                vec![
                    ("DB_DRIVER", "oracle"),
                    ("DB_HOST", "h"),
                    ("DB_USER", "u"),
                    ("DB_NAME", "svc"),
                    ("DB_ORACLE_SID", "X"),
                ],
                "one of",
            ),
            (
                "dsn plus password",
                with(&pg_dsn, &[("DB_PASSWORD", "p")]),
                "db_password",
            ),
            (
                "dsn plus dsn_cmd",
                with(&pg_dsn, &[("DB_DSN_CMD", "echo x")]),
                "mutually exclusive",
            ),
            (
                "password plus password_cmd",
                with(&pg_db, &[("DB_PASSWORD", "p"), ("DB_PASSWORD_CMD", "c")]),
                "mutually exclusive",
            ),
            ("bad port", with(&pg_db, &[("DB_PORT", "nan")]), "db_port"),
            (
                "bad max_rows",
                with(&pg_db, &[("DB_MAX_ROWS", "-2")]),
                "db_max_rows",
            ),
            (
                "bad permissions",
                with(&pg_db, &[("DB_PERMISSIONS", "read,admin")]),
                "permission",
            ),
            (
                "bad timeout",
                with(&pg_db, &[("DB_QUERY_TIMEOUT", "nope")]),
                "query_timeout",
            ),
            (
                "bad allow_unfiltered_writes",
                with(&pg_dsn, &[("DB_ALLOW_UNFILTERED_WRITES", "maybe")]),
                "db_allow_unfiltered_writes",
            ),
        ];
        for (label, vars, want) in cases {
            let Some(err) = load(&vars).err() else {
                panic!("{label}: expected an error, got none");
            };
            let message = err.to_string().to_lowercase();
            assert!(
                message.contains(want),
                "{label}: {message:?} lacks {want:?}"
            );
        }
    }

    /// The code points Node's trim() strips, found by running every code point
    /// through it.
    fn trimmed_by_javascript(c: char) -> bool {
        matches!(
            u32::from(c),
            0x9..=0xd
                | 0x20
                | 0xa0
                | 0x1680
                | 0x2000..=0x200a
                | 0x2028
                | 0x2029
                | 0x202f
                | 0x205f
                | 0x3000
                | 0xfeff
        )
    }

    #[test]
    fn js_trim_strips_exactly_what_javascript_strips() {
        let mut buf = [0u8; 4];
        for c in (0..=u32::from(char::MAX)).filter_map(char::from_u32) {
            assert_eq!(
                js_trim(c.encode_utf8(&mut buf)).is_empty(),
                trimmed_by_javascript(c),
                "U+{:04X}",
                u32::from(c)
            );
        }
        assert_eq!(js_trim(" \u{85}x\u{feff} "), "\u{85}x");
    }

    #[test]
    fn trims_values_as_javascript_does() {
        let c = load(&[
            ("DB_DRIVER", "\u{feff}postgres "),
            ("DB_HOST", "\u{feff}h\u{85}"),
            ("DB_USER", "u"),
            ("DB_NAME", "d"),
        ])
        .unwrap();
        assert_eq!(c.driver, "postgres");
        assert_eq!(c.host, "h\u{85}");
    }

    #[test]
    fn no_warning_without_a_config_json() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(stale_global_config_warning(dir.path()), None);
    }

    #[test]
    fn warns_when_the_retired_config_json_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            stale_global_config_warning(dir.path()).unwrap(),
            format!(
                "db-mcp: warning: {} is no longer read; move each project's connection into its .mcp.json env (DB_DRIVER + DB_PERMISSIONS + DB_DSN_CMD) and delete this file\n",
                path.display()
            )
        );
    }

    /// Node's existsSync follows symbolic links, so a dangling one is absent.
    #[cfg(unix)]
    #[test]
    fn no_warning_for_a_dangling_config_json_link() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("missing.json", dir.path().join("config.json")).unwrap();
        assert_eq!(stale_global_config_warning(dir.path()), None);
    }
}

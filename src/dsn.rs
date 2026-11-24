//! Connection-string assembly and parsing for the three supported drivers.
//!
//! Backward compatibility is the whole point of this module: DSNs already
//! stored in the macOS Keychain were produced by the Go build, so `build_dsn`
//! reproduces Go's escaping byte-for-byte and `parse_dsn` reads those exact
//! strings back. Formats:
//!
//! ```text
//! postgres://user:pass@host:5432/db
//! sqlserver://user:pass@host:1433?database=db
//! oracle://user:pass@host:1521/service
//! oracle://user:pass@host:1521/?SID=ORCL
//! ```

use std::collections::HashMap;
use std::fmt::Write as _;

use anyhow::{Result, bail};
use percent_encoding::percent_decode_str;
use url::Url;

use crate::drivers::{DriverInfo, SqlDriver, resolve_driver};

/// The discrete fields a DSN is assembled from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DsnFields {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// Database name; for Oracle, the service name. Empty when unset.
    pub database: String,
    /// Oracle only, mutually exclusive with `database`. Empty when unset.
    pub oracle_sid: String,
}

/// A DSN taken apart into the pieces a driver's config needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DsnParts {
    pub user: String,
    pub password: String,
    pub host: String,
    /// 0 when the DSN names no port.
    pub port: u16,
    /// Database name; for Oracle, the service name. Empty when connecting by SID.
    pub database: String,
    /// Oracle only. Empty unless the DSN carries `?SID=`.
    pub oracle_sid: String,
    /// Query-string options with lower-cased keys; the last occurrence wins.
    pub options: HashMap<String, String>,
}

// --- Go net/url escaping ------------------------------------------------
//
// Go's url package escapes per context; reproducing the contexts it uses keeps
// generated DSNs identical to the Go build's. Escaping applies to UTF-8 bytes
// and emits uppercase hex, as Go does.

/// Characters no context escapes, besides ASCII letters and digits.
const UNRESERVED: &[u8] = b"-_.~";

fn escape_with(s: &str, allowed: &[u8], space_as_plus: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(&byte) || allowed.contains(&byte) {
            out.push(char::from(byte));
        } else if space_as_plus && byte == b' ' {
            out.push('+');
        } else {
            // Writing into a String cannot fail.
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// Go's encodeUserPassword: escapes '@', '/', '?' and ':' from the reserved set.
fn escape_userinfo(s: &str) -> String {
    escape_with(s, b"$&+,;=", false)
}

/// Go's encodePath (used by url.URL.String() for the path): escapes only '?'.
fn escape_path(s: &str) -> String {
    escape_with(s, b"$&+,/:;=@", false)
}

/// Go's url.PathEscape / encodePathSegment: escapes '/', ';', ',' and '?'.
fn escape_path_segment(s: &str) -> String {
    escape_with(s, b"$&+:=@", false)
}

/// Go's url.QueryEscape: everything but unreserved, space becomes '+'.
fn escape_query(s: &str) -> String {
    escape_with(s, b"", true)
}

// --- build ---------------------------------------------------------------

/// Assembles a driver-native connection string from discrete fields. Used when
/// DB_DSN / DB_DSN_CMD are not set, and by the keychain CLI when storing a new
/// connection.
pub fn build_dsn(driver: SqlDriver, f: &DsnFields) -> Result<String> {
    let hostport = format!("{}:{}", f.host, f.port);
    let userinfo = format!(
        "{}:{}",
        escape_userinfo(&f.user),
        escape_userinfo(&f.password)
    );

    match driver {
        SqlDriver::Pgx => {
            if f.database.is_empty() {
                bail!("DB_NAME is required for postgres");
            }
            Ok(format!(
                "postgres://{userinfo}@{hostport}/{}",
                escape_path(&f.database)
            ))
        }
        SqlDriver::SqlServer => {
            if f.database.is_empty() {
                bail!("DB_NAME is required for sqlserver");
            }
            Ok(format!(
                "sqlserver://{userinfo}@{hostport}?database={}",
                escape_query(&f.database)
            ))
        }
        SqlDriver::Oracle => {
            // Matches go-ora's BuildUrl: PathEscape on user, password and service.
            let ora_user = escape_path_segment(&f.user);
            let ora_pass = escape_path_segment(&f.password);
            if !f.oracle_sid.is_empty() {
                return Ok(format!(
                    "oracle://{ora_user}:{ora_pass}@{hostport}/?SID={}",
                    escape_query(&f.oracle_sid)
                ));
            }
            if f.database.is_empty() {
                bail!("oracle requires DB_NAME (service name) or DB_ORACLE_SID");
            }
            Ok(format!(
                "oracle://{ora_user}:{ora_pass}@{hostport}/{}",
                escape_path_segment(&f.database)
            ))
        }
    }
}

// --- parse ---------------------------------------------------------------

/// Takes a stored DSN apart. The drivers need the pieces separately, and
/// `db-mcp test` reports the target without ever printing the secret.
///
/// Parsing follows the WHATWG URL rules, so a bare '@' in a password (which
/// go-ora's escaping leaves alone) is handled: the last '@' ends the userinfo.
pub fn parse_dsn(driver: SqlDriver, dsn: &str) -> Result<DsnParts> {
    let Ok(u) = Url::parse(dsn.trim()) else {
        bail!("could not parse the connection string as a URL");
    };

    let mut options = HashMap::new();
    for (k, v) in u.query_pairs() {
        options.insert(k.to_lowercase(), v.into_owned());
    }

    // The path is "/name" for postgres and oracle service connections, and
    // empty (or "/") when the target rides in the query string instead.
    let path = u.path();
    let path_name = safe_decode(path.strip_prefix('/').unwrap_or(path));

    let mut parts = DsnParts {
        user: safe_decode(u.username()),
        password: safe_decode(u.password().unwrap_or("")),
        host: safe_decode(u.host_str().unwrap_or("")),
        port: u.port().unwrap_or(0),
        options,
        ..Default::default()
    };

    match driver {
        SqlDriver::Pgx => parts.database = path_name,
        SqlDriver::SqlServer => {
            parts.database = parts.options.get("database").cloned().unwrap_or(path_name);
        }
        SqlDriver::Oracle => match parts.options.get("sid") {
            Some(sid) if !sid.is_empty() => parts.oracle_sid = sid.clone(),
            _ => parts.database = path_name,
        },
    }
    Ok(parts)
}

/// Percent-decodes userinfo, host or path text. A malformed escape or bytes
/// that are not valid UTF-8 leave the text exactly as it was instead of
/// failing: a password may legitimately contain a stray '%' if it was stored
/// without escaping.
fn safe_decode(s: &str) -> String {
    // Every '%' must be followed by two hex digits, or nothing is decoded.
    let well_formed = s.split('%').skip(1).all(|after| {
        after
            .as_bytes()
            .get(..2)
            .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
    });
    if !well_formed {
        return s.to_owned();
    }
    percent_decode_str(s)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| s.to_owned())
}

/// The connect string a thin Oracle driver expects. A service name uses Easy
/// Connect syntax; a SID has no Easy Connect form and must be given as an
/// embedded connect descriptor.
pub fn oracle_connect_string(parts: &DsnParts) -> String {
    if !parts.oracle_sid.is_empty() {
        return format!(
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={})(PORT={}))(CONNECT_DATA=(SID={})))",
            parts.host, parts.port, parts.oracle_sid
        );
    }
    format!("{}:{}/{}", parts.host, parts.port, parts.database)
}

/// Infers the driver from a DSN's URL scheme. Every DSN db-mcp stores names its
/// driver up front ("postgres://", "sqlserver://", "oracle://"), so a stored
/// connection can be probed without asking which engine it belongs to.
pub fn driver_from_dsn(dsn: &str) -> Option<DriverInfo> {
    let (scheme, _) = dsn.trim().split_once("://")?;
    let mut chars = scheme.chars();
    let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let rest_valid = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if starts_with_letter && rest_valid {
        resolve_driver(scheme)
    } else {
        None
    }
}

/// A human-readable target for CLI output. Never includes the password.
pub fn describe_target(parts: &DsnParts) -> String {
    let target = if parts.oracle_sid.is_empty() {
        parts.database.clone()
    } else {
        format!("SID={}", parts.oracle_sid)
    };
    let place = if parts.port == 0 {
        parts.host.clone()
    } else {
        format!("{}:{}", parts.host, parts.port)
    };
    if target.is_empty() {
        place
    } else {
        format!("{place}/{target}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Discrete fields with everything but the database/SID filled in.
    fn fields(host: &str, port: u16, user: &str, password: &str) -> DsnFields {
        DsnFields {
            host: host.into(),
            port,
            user: user.into(),
            password: password.into(),
            ..Default::default()
        }
    }

    fn with_db(mut f: DsnFields, database: &str) -> DsnFields {
        f.database = database.into();
        f
    }

    fn with_sid(mut f: DsnFields, sid: &str) -> DsnFields {
        f.oracle_sid = sid.into();
        f
    }

    #[test]
    fn matches_the_go_postgres_format() {
        let dsn = build_dsn(SqlDriver::Pgx, &with_db(fields("h", 5432, "u", "p"), "d")).unwrap();
        assert_eq!(dsn, "postgres://u:p@h:5432/d");
    }

    #[test]
    fn matches_the_go_sqlserver_format() {
        let f = with_db(fields("h", 1433, "u", "p"), "d");
        let dsn = build_dsn(SqlDriver::SqlServer, &f).unwrap();
        assert_eq!(dsn, "sqlserver://u:p@h:1433?database=d");
    }

    #[test]
    fn matches_go_ora_build_url_for_a_service_name() {
        let f = with_db(fields("h", 1521, "u", "p"), "svc");
        let dsn = build_dsn(SqlDriver::Oracle, &f).unwrap();
        assert_eq!(dsn, "oracle://u:p@h:1521/svc");
    }

    #[test]
    fn matches_go_ora_build_url_for_a_sid() {
        let f = with_sid(fields("h", 1521, "u", "p"), "ORCL");
        let dsn = build_dsn(SqlDriver::Oracle, &f).unwrap();
        assert_eq!(dsn, "oracle://u:p@h:1521/?SID=ORCL");
    }

    #[test]
    fn escapes_userinfo_the_way_go_does() {
        // '@' ':' '/' '?' are escaped; '$' '&' '+' ',' ';' '=' are not.
        let f = with_db(fields("h", 5432, "us:er", "p@ss/wo?rd"), "d");
        let dsn = build_dsn(SqlDriver::Pgx, &f).unwrap();
        assert_eq!(dsn, "postgres://us%3Aer:p%40ss%2Fwo%3Frd@h:5432/d");
    }

    #[test]
    fn leaves_gos_unreserved_in_userinfo_characters_alone() {
        let f = with_db(fields("h", 5432, "u", "a$b&c+d,e;f=g"), "d");
        let dsn = build_dsn(SqlDriver::Pgx, &f).unwrap();
        assert_eq!(dsn, "postgres://u:a$b&c+d,e;f=g@h:5432/d");
    }

    #[test]
    fn percent_encodes_non_ascii_as_utf8_bytes() {
        let f = with_db(fields("h", 5432, "u", "\u{e9}"), "d");
        let dsn = build_dsn(SqlDriver::Pgx, &f).unwrap();
        assert_eq!(dsn, "postgres://u:%C3%A9@h:5432/d");
    }

    #[test]
    fn requires_a_database_name_where_the_driver_needs_one() {
        let err = build_dsn(SqlDriver::Pgx, &fields("h", 5432, "u", "p")).unwrap_err();
        assert!(err.to_string().contains("DB_NAME"), "{err}");
        let err = build_dsn(SqlDriver::Oracle, &fields("h", 1521, "u", "p")).unwrap_err();
        assert!(err.to_string().contains("DB_ORACLE_SID"), "{err}");
    }

    #[test]
    fn reads_back_a_go_written_postgres_dsn() {
        let p = parse_dsn(SqlDriver::Pgx, "postgres://u:p@h:5432/d").unwrap();
        assert_eq!(
            (p.user.as_str(), p.password.as_str(), p.host.as_str()),
            ("u", "p", "h")
        );
        assert_eq!((p.port, p.database.as_str()), (5432, "d"));
    }

    #[test]
    fn reads_back_a_go_written_sqlserver_dsn() {
        let p = parse_dsn(SqlDriver::SqlServer, "sqlserver://u:p@h:1433?database=d").unwrap();
        assert_eq!(
            (p.user.as_str(), p.password.as_str(), p.host.as_str()),
            ("u", "p", "h")
        );
        assert_eq!((p.port, p.database.as_str()), (1433, "d"));
    }

    #[test]
    fn reads_back_a_go_written_oracle_service_dsn() {
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@h:1521/svc").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("h", 1521));
        assert_eq!((p.database.as_str(), p.oracle_sid.as_str()), ("svc", ""));
    }

    #[test]
    fn reads_back_a_go_written_oracle_sid_dsn() {
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@h:1521/?SID=ORCL").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("h", 1521));
        assert_eq!((p.database.as_str(), p.oracle_sid.as_str()), ("", "ORCL"));
    }

    #[test]
    fn percent_decodes_credentials() {
        let p = parse_dsn(SqlDriver::Pgx, "postgres://us%3Aer:p%40ss@h:5432/d").unwrap();
        assert_eq!(p.user, "us:er");
        assert_eq!(p.password, "p@ss");
    }

    #[test]
    fn takes_the_last_at_sign_as_the_authority_separator() {
        // go-ora's PathEscape leaves '@' unescaped in passwords, so a stored
        // Oracle DSN can contain a bare '@' in the password.
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@ss@h:1521/svc").unwrap();
        assert_eq!(p.user, "u");
        assert_eq!(p.password, "p@ss");
        assert_eq!(p.host, "h");
    }

    #[test]
    fn rejects_a_string_that_is_not_a_url() {
        let err = parse_dsn(SqlDriver::Pgx, "not a dsn").unwrap_err();
        assert!(err.to_string().contains("could not parse"), "{err}");
    }

    #[test]
    fn leaves_a_malformed_escape_undecoded() {
        // A stray '%' must not fail the parse or mangle the rest of the value.
        let p = parse_dsn(SqlDriver::Pgx, "postgres://u:50%zz%41@h:5432/d").unwrap();
        assert_eq!(p.password, "50%zz%41");
    }

    #[test]
    fn survives_build_then_parse() {
        let trips = [
            (
                SqlDriver::Pgx,
                with_db(fields("db.example.com", 5432, "u ser", "p@:s/s?w&d"), "app"),
            ),
            (
                SqlDriver::SqlServer,
                with_db(fields("db", 1433, "sa", "P@ssw0rd!"), "app"),
            ),
            (
                SqlDriver::Oracle,
                with_db(fields("ora", 1521, "hr", "s3cr%t"), "ORCLPDB1"),
            ),
            (
                SqlDriver::Oracle,
                with_sid(fields("ora", 1521, "hr", "s3cret"), "ORCL"),
            ),
        ];
        for (driver, f) in trips {
            let dsn = build_dsn(driver, &f).unwrap();
            let p = parse_dsn(driver, &dsn).unwrap();
            assert_eq!(p.user, f.user, "user via {dsn}");
            assert_eq!(p.password, f.password, "password via {dsn}");
            assert_eq!(p.host, f.host, "host via {dsn}");
            assert_eq!(p.port, f.port, "port via {dsn}");
            assert_eq!(p.database, f.database, "database via {dsn}");
            assert_eq!(p.oracle_sid, f.oracle_sid, "SID via {dsn}");
        }
    }

    #[test]
    fn uses_easy_connect_syntax_for_a_service_name() {
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@h:1521/svc").unwrap();
        assert_eq!(oracle_connect_string(&p), "h:1521/svc");
    }

    #[test]
    fn uses_an_embedded_connect_descriptor_for_a_sid() {
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@h:1521/?SID=ORCL").unwrap();
        assert_eq!(
            oracle_connect_string(&p),
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))"
        );
    }

    #[test]
    fn describe_target_never_includes_the_password() {
        let p = parse_dsn(SqlDriver::Pgx, "postgres://u:sup3rsecret@h:5432/d").unwrap();
        let out = describe_target(&p);
        assert_eq!(out, "h:5432/d");
        assert!(!out.contains("sup3rsecret"));
    }

    #[test]
    fn describe_target_names_the_sid_when_connecting_by_sid() {
        let p = parse_dsn(SqlDriver::Oracle, "oracle://u:p@h:1521/?SID=ORCL").unwrap();
        assert_eq!(describe_target(&p), "h:1521/SID=ORCL");
    }

    #[test]
    fn infers_the_driver_from_the_scheme() {
        let pg = driver_from_dsn("  postgres://u:p@h:5432/d").map(|i| i.sql_driver);
        assert_eq!(pg, Some(SqlDriver::Pgx));
        let ora = driver_from_dsn("oracle://u:p@h:1521/svc").map(|i| i.sql_driver);
        assert_eq!(ora, Some(SqlDriver::Oracle));
        assert!(driver_from_dsn("mysql://u:p@h/d").is_none());
        assert!(driver_from_dsn("h:5432/d").is_none());
    }
}

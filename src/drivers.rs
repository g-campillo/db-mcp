//! Driver identity: the user-facing name in DB_DRIVER, the internal driver key
//! used to branch catalog SQL and placeholder syntax, and the default port.

/// Internal driver key. The variants keep the Go build's driver names, so the
/// ported catalog SQL reads the same way it always has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDriver {
    Pgx,
    SqlServer,
    Oracle,
}

/// Everything known about a driver once its name has been resolved
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DriverInfo {
    pub sql_driver: SqlDriver,

    /// User-facing label, e.g. in error messages and tool descriptions.
    pub display_name: &'static str,
    pub default_port: u16,
}

/// Maps a user-facing driver name or alias to its internal key, display label
/// and default port. Returns `None` for an unknown driver.
pub fn resolve_driver(driver: &str) -> Option<DriverInfo> {
    let (sql_driver, display_name, default_port) = match driver.trim().to_lowercase().as_str() {
        "postgres" | "postgresql" => (SqlDriver::Pgx, "postgres", 5432),
        "sqlserver" | "mssql" => (SqlDriver::SqlServer, "sqlserver", 1433),
        "oracle" => (SqlDriver::Oracle, "oracle", 1521),
        _ => return None,
    };

    Some(DriverInfo {
        sql_driver,
        display_name,
        default_port,
    })
}

/// The driver names accepted in DB_DRIVER and offered by the keychain CLI.
pub const DRIVER_CHOICES: [&str; 3] = ["postgres", "sqlserver", "oracle"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_alias() {
        let cases = [
            ("postgres", SqlDriver::Pgx, 5432),
            ("postgresql", SqlDriver::Pgx, 5432),
            ("sqlserver", SqlDriver::SqlServer, 1433),
            ("mssql", SqlDriver::SqlServer, 1433),
            ("oracle", SqlDriver::Oracle, 1521),
            (" ORACLE ", SqlDriver::Oracle, 1521),
        ];

        for (alias, sql_driver, port) in cases {
            let Some(info) = resolve_driver(alias) else {
                panic!("{alias:?} did not resolve");
            };

            assert_eq!(info.sql_driver, sql_driver, "driver for {alias:?}");
            assert_eq!(info.default_port, port, "default port for {alias:?}");
        }
    }

    #[test]
    fn rejects_an_unknown_driver() {
        assert!(resolve_driver("mysql").is_none());
    }
}

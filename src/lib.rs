//! db-mcp: an MCP server that runs SQL against PostgreSQL, SQL Server or
//! Oracle, one database per process, with per-project permission gating.
//!
//! The library holds all of the logic; the `db-mcp` binary (src/main.rs, added
//! with the CLI) is a thin entry point on top of it.

pub mod audit;
pub mod config;
pub mod drivers;
pub mod dsn;
pub mod duration;
pub mod keychain;
pub mod paths;
pub mod permissions;

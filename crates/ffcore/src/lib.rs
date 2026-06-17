pub mod db;
pub mod detect;
pub mod engine;
pub mod git;
pub mod ignore;
pub mod merge;
pub mod query;
pub mod revert;
pub mod runner;
pub mod search;
pub mod store;
pub mod sysmon;
pub mod watcher;

pub use db::Db;
pub use engine::Engine;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Walk(#[from] ::ignore::Error),
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error("{0}")]
    Msg(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// UTC calendar day for a unix-seconds timestamp, e.g. "2026-06-02".
/// Used as the retention/coalesce bucket so pruning is deterministic.
pub fn day_bucket(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

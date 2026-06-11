use std::path::Path;

use rusqlite::Connection;

use crate::Result;

pub struct Db {
    pub conn: Connection,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    pub max_disk_gb: f64,
    pub retention_days: i64,
    pub snapshots_per_past_day: i64,
    pub default_interval_secs: i64,
    /// Minimum seconds between consecutive event-triggered snapshots. Bursts of
    /// saves (e.g. live-reload tooling) coalesce into at most one point per gap.
    pub event_min_gap_secs: i64,
    pub ignore_globs: Vec<String>,
    /// When false (default), capture every file like a local-history tool —
    /// .gitignore is not consulted, so .env and similar still get history.
    pub respect_gitignore: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_disk_gb: 1.0,
            retention_days: 30,
            snapshots_per_past_day: 2,
            default_interval_secs: 900,
            event_min_gap_secs: 20,
            ignore_globs: Vec::new(),
            respect_gitignore: false,
        }
    }
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // WAL + NORMAL is durable across app crashes and skips the per-commit
        // fsync that makes bulk deletes crawl on Linux.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        // Add columns introduced after the initial schema (ignore if present).
        let _ = conn.execute("ALTER TABLE snapshots ADD COLUMN label TEXT", []);
        let db = Self { conn };
        db.seed_defaults()?;
        Ok(db)
    }

    fn seed_defaults(&self) -> Result<()> {
        let d = Settings::default();
        let pairs = [
            ("max_disk_gb", d.max_disk_gb.to_string()),
            ("retention_days", d.retention_days.to_string()),
            ("snapshots_per_past_day", d.snapshots_per_past_day.to_string()),
            ("default_interval_secs", d.default_interval_secs.to_string()),
            ("event_min_gap_secs", d.event_min_gap_secs.to_string()),
            ("ignore_globs", String::new()),
            ("respect_gitignore", "0".to_string()),
        ];
        for (k, v) in pairs {
            self.conn
                .execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?1, ?2)", (k, v))?;
        }
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let v = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .ok();
        Ok(v)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings> {
        let d = Settings::default();
        let num = |k: &str, fallback: f64| -> f64 {
            self.get_setting(k)
                .ok()
                .flatten()
                .and_then(|s| s.parse().ok())
                .unwrap_or(fallback)
        };
        let globs = self
            .get_setting("ignore_globs")?
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect();
        let respect_gitignore = self
            .get_setting("respect_gitignore")?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(d.respect_gitignore);
        Ok(Settings {
            max_disk_gb: num("max_disk_gb", d.max_disk_gb),
            retention_days: num("retention_days", d.retention_days as f64) as i64,
            snapshots_per_past_day: num("snapshots_per_past_day", d.snapshots_per_past_day as f64) as i64,
            default_interval_secs: num("default_interval_secs", d.default_interval_secs as f64) as i64,
            event_min_gap_secs: num("event_min_gap_secs", d.event_min_gap_secs as f64) as i64,
            ignore_globs: globs,
            respect_gitignore,
        })
    }

    pub fn add_monitor(&self, root_path: &str, interval_secs: i64, source: &str, created_at: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO monitors(root_path, interval_secs, source, active, created_at)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(root_path) DO UPDATE SET active = 1, source = excluded.source",
            (root_path, interval_secs, source, created_at),
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM monitors WHERE root_path = ?1",
            [root_path],
            |r| r.get(0),
        )?;
        Ok(id)
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path     TEXT NOT NULL UNIQUE,
    interval_secs INTEGER NOT NULL DEFAULT 900,
    source        TEXT NOT NULL DEFAULT 'manual',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ts            INTEGER NOT NULL,
    trigger       TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    file_count    INTEGER NOT NULL,
    total_size    INTEGER NOT NULL,
    day_bucket    TEXT NOT NULL,
    keep_reason   TEXT,
    label         TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_monitor_ts ON snapshots(monitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_day ON snapshots(day_bucket);

-- Content-addressed by blake3 hash; refcount = number of snapshots whose
-- manifest references this blob (manifests are themselves stored as blobs).
CREATE TABLE IF NOT EXISTS blobs (
    hash     TEXT PRIMARY KEY,
    size     INTEGER NOT NULL,
    refcount INTEGER NOT NULL DEFAULT 0
);
"#;

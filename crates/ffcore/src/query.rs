use serde::Serialize;

use crate::store::{BlobStore, Manifest};
use crate::{Db, Result};

#[derive(Debug, Clone, Serialize)]
pub struct MonitorRow {
    pub id: i64,
    pub root_path: String,
    pub interval_secs: i64,
    pub source: String,
    pub active: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotRow {
    pub id: i64,
    pub monitor_id: i64,
    pub ts: i64,
    pub trigger: String,
    pub file_count: i64,
    pub total_size: i64,
    pub day_bucket: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    pub status: ChangeStatus,
}

pub fn list_monitors(db: &Db) -> Result<Vec<MonitorRow>> {
    let mut stmt = db.conn.prepare(
        "SELECT id, root_path, interval_secs, source, active, created_at
         FROM monitors ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MonitorRow {
            id: r.get(0)?,
            root_path: r.get(1)?,
            interval_secs: r.get(2)?,
            source: r.get(3)?,
            active: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn list_snapshots(db: &Db, monitor_id: i64) -> Result<Vec<SnapshotRow>> {
    let mut stmt = db.conn.prepare(
        "SELECT id, monitor_id, ts, trigger, file_count, total_size, day_bucket, label
         FROM snapshots WHERE monitor_id = ?1 ORDER BY ts DESC, id DESC",
    )?;
    let rows = stmt.query_map([monitor_id], |r| {
        Ok(SnapshotRow {
            id: r.get(0)?,
            monitor_id: r.get(1)?,
            ts: r.get(2)?,
            trigger: r.get(3)?,
            file_count: r.get(4)?,
            total_size: r.get(5)?,
            day_bucket: r.get(6)?,
            label: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn load_manifest(db: &Db, store: &BlobStore, snapshot_id: i64) -> Result<Manifest> {
    let hash: String = db.conn.query_row(
        "SELECT manifest_hash FROM snapshots WHERE id = ?1",
        [snapshot_id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_slice(&store.get(&hash)?)?)
}

/// The snapshot immediately preceding `snapshot_id` for the same monitor — the
/// baseline a breaking point's changes are shown against.
pub fn previous_snapshot(db: &Db, snapshot_id: i64) -> Result<Option<i64>> {
    // Row-value compare on (ts, id): ts has 1-second resolution, so a same-second
    // predecessor is still ordered correctly by id rather than being skipped.
    Ok(db
        .conn
        .query_row(
            "SELECT id FROM snapshots
             WHERE monitor_id = (SELECT monitor_id FROM snapshots WHERE id = ?1)
               AND (ts, id) < (SELECT ts, id FROM snapshots WHERE id = ?1)
             ORDER BY ts DESC, id DESC LIMIT 1",
            [snapshot_id],
            |r| r.get(0),
        )
        .ok())
}

/// All file paths captured in a snapshot (used to show the first breaking
/// point, which has no baseline to diff against).
pub fn snapshot_paths(db: &Db, store: &BlobStore, snapshot_id: i64) -> Result<Vec<String>> {
    let mut paths: Vec<String> = load_manifest(db, store, snapshot_id)?
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    paths.sort();
    Ok(paths)
}

/// File-level diff between two snapshot manifests (added / modified / deleted).
pub fn changed_files(db: &Db, store: &BlobStore, from: i64, to: i64) -> Result<Vec<FileChange>> {
    use std::collections::BTreeMap;
    let map = |id| -> Result<BTreeMap<String, String>> {
        Ok(load_manifest(db, store, id)?
            .entries
            .into_iter()
            .map(|e| (e.path, e.hash))
            .collect())
    };
    let old = map(from)?;
    let new = map(to)?;

    let mut changes = Vec::new();
    for (path, hash) in &new {
        match old.get(path) {
            None => changes.push(FileChange { path: path.clone(), status: ChangeStatus::Added }),
            Some(h) if h != hash => {
                changes.push(FileChange { path: path.clone(), status: ChangeStatus::Modified })
            }
            _ => {}
        }
    }
    for path in old.keys() {
        if !new.contains_key(path) {
            changes.push(FileChange { path: path.clone(), status: ChangeStatus::Deleted });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

/// Raw bytes of `path` as captured in `snapshot_id`, or `None` if absent.
pub fn file_at(db: &Db, store: &BlobStore, snapshot_id: i64, path: &str) -> Result<Option<Vec<u8>>> {
    let manifest = load_manifest(db, store, snapshot_id)?;
    match manifest.entries.iter().find(|e| e.path == path) {
        Some(e) => Ok(Some(store.get(&e.hash)?)),
        None => Ok(None),
    }
}

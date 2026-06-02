use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::store::BlobStore;
use crate::{day_bucket, Db, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
    pub mode: u32,
    pub size: u64,
}

/// Snapshot of a tree as a sorted list of files. mtime is deliberately
/// excluded so the manifest hash equals the tree's content identity:
/// a re-snapshot with no content change produces the same hash and is skipped.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    /// Stores `content` as a blob and records the file in the manifest.
    pub fn add_file(&mut self, store: &BlobStore, path: &str, mode: u32, content: &[u8]) -> Result<()> {
        let hash = store.put(content)?;
        self.entries.push(ManifestEntry {
            path: path.to_string(),
            hash,
            mode,
            size: content.len() as u64,
        });
        Ok(())
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let mut entries = self.entries.clone();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(serde_json::to_vec(&Manifest { entries })?)
    }

    /// Stable identity of the tree (the snapshot's `manifest_hash`).
    pub fn content_hash(&self) -> Result<String> {
        Ok(BlobStore::hash(&self.canonical_bytes()?))
    }
}

pub struct SnapshotInput {
    pub monitor_id: i64,
    pub trigger: String,
    pub ts: i64,
    pub manifest: Manifest,
}

/// Creates a snapshot, deduping blobs against the store and skipping when the
/// tree is byte-identical to the monitor's most recent snapshot.
/// Returns `Ok(None)` when nothing changed. Assumes the content blobs were
/// already written to `store` (e.g. via [`Manifest::add_file`]).
pub fn create_snapshot(db: &Db, store: &BlobStore, input: SnapshotInput) -> Result<Option<i64>> {
    let bytes = input.manifest.canonical_bytes()?;
    let manifest_hash = store.put(&bytes)?;

    let last: Option<String> = db
        .conn
        .query_row(
            "SELECT manifest_hash FROM snapshots WHERE monitor_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
            [input.monitor_id],
            |r| r.get(0),
        )
        .ok();
    if last.as_deref() == Some(manifest_hash.as_str()) {
        return Ok(None);
    }

    let file_count = input.manifest.entries.len() as i64;
    let total_size: i64 = input.manifest.entries.iter().map(|e| e.size as i64).sum();

    db.conn.execute(
        "INSERT INTO snapshots(monitor_id, ts, trigger, manifest_hash, file_count, total_size, day_bucket)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            input.monitor_id,
            input.ts,
            &input.trigger,
            &manifest_hash,
            file_count,
            total_size,
            day_bucket(input.ts),
        ),
    )?;
    let snapshot_id = db.conn.last_insert_rowid();

    // One ref per snapshot for each distinct blob it references (the manifest
    // blob plus every content blob), so GC frees a blob exactly when its last
    // referencing snapshot is deleted.
    let mut sizes: HashMap<&str, u64> = HashMap::new();
    for e in &input.manifest.entries {
        sizes.insert(&e.hash, e.size);
    }
    sizes.insert(&manifest_hash, bytes.len() as u64);
    for (hash, size) in sizes {
        bump_ref(db, hash, size as i64)?;
    }

    Ok(Some(snapshot_id))
}

pub fn delete_snapshot(db: &Db, store: &BlobStore, snapshot_id: i64) -> Result<()> {
    let manifest_hash: String = db.conn.query_row(
        "SELECT manifest_hash FROM snapshots WHERE id = ?1",
        [snapshot_id],
        |r| r.get(0),
    )?;
    let manifest: Manifest = serde_json::from_slice(&store.get(&manifest_hash)?)?;

    db.conn
        .execute("DELETE FROM snapshots WHERE id = ?1", [snapshot_id])?;

    let mut hashes: Vec<String> = manifest.entries.into_iter().map(|e| e.hash).collect();
    hashes.push(manifest_hash);
    hashes.sort();
    hashes.dedup();
    for hash in hashes {
        dec_ref(db, store, &hash)?;
    }
    Ok(())
}

fn bump_ref(db: &Db, hash: &str, size: i64) -> Result<()> {
    db.conn.execute(
        "INSERT INTO blobs(hash, size, refcount) VALUES (?1, ?2, 1)
         ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1",
        (hash, size),
    )?;
    Ok(())
}

fn dec_ref(db: &Db, store: &BlobStore, hash: &str) -> Result<()> {
    db.conn
        .execute("UPDATE blobs SET refcount = refcount - 1 WHERE hash = ?1", [hash])?;
    let refcount: i64 = db
        .conn
        .query_row("SELECT refcount FROM blobs WHERE hash = ?1", [hash], |r| r.get(0))
        .unwrap_or(0);
    if refcount <= 0 {
        store.remove(hash)?;
        db.conn.execute("DELETE FROM blobs WHERE hash = ?1", [hash])?;
    }
    Ok(())
}

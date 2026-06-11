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
    delete_snapshots(db, store, &[snapshot_id])
}

/// Deletes a batch of snapshots in one transaction. Without the batching every
/// per-blob statement commits (and fsyncs) individually, which makes removing
/// a large monitor take minutes. Refcounts are decremented in bulk; orphaned
/// blob files are unlinked only after the commit, so an aborted transaction
/// can never leave a still-referenced blob missing from disk.
pub fn delete_snapshots(db: &Db, store: &BlobStore, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = db.conn.unchecked_transaction()?;

    let mut decrements: HashMap<String, i64> = HashMap::new();
    {
        let mut sel = db.conn.prepare("SELECT manifest_hash FROM snapshots WHERE id = ?1")?;
        let mut del = db.conn.prepare("DELETE FROM snapshots WHERE id = ?1")?;
        for id in ids {
            let manifest_hash: String = sel.query_row([id], |r| r.get(0))?;
            let manifest: Manifest = serde_json::from_slice(&store.get(&manifest_hash)?)?;
            let mut hashes: Vec<String> =
                manifest.entries.into_iter().map(|e| e.hash).collect();
            hashes.push(manifest_hash);
            hashes.sort();
            hashes.dedup();
            for h in hashes {
                *decrements.entry(h).or_insert(0) += 1;
            }
            del.execute([id])?;
        }
    }

    let mut orphans: Vec<String> = Vec::new();
    {
        let mut upd =
            db.conn.prepare("UPDATE blobs SET refcount = refcount - ?1 WHERE hash = ?2")?;
        let mut sel = db.conn.prepare("SELECT refcount FROM blobs WHERE hash = ?1")?;
        let mut del = db.conn.prepare("DELETE FROM blobs WHERE hash = ?1")?;
        for (hash, n) in &decrements {
            upd.execute((n, hash))?;
            let refcount: i64 = sel.query_row([hash], |r| r.get(0)).unwrap_or(0);
            if refcount <= 0 {
                del.execute([hash])?;
                orphans.push(hash.clone());
            }
        }
    }
    tx.commit()?;

    for hash in orphans {
        store.remove(&hash)?;
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

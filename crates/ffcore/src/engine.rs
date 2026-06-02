use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ignore::build_manifest;
use crate::store::prune::prune;
use crate::store::{create_snapshot, BlobStore, SnapshotInput};
use crate::{query, revert, Db, Result};

/// App-facing core: owns the metadata DB and blob store and turns "snapshot
/// this monitor now" requests into deduped snapshots, pruning afterwards.
pub struct Engine {
    db: Mutex<Db>,
    store: BlobStore,
}

impl Engine {
    pub fn open(data_dir: &Path) -> Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir)?;
        let db = Db::open(data_dir.join("db.sqlite"))?;
        let store = BlobStore::new(data_dir)?;
        Ok(Arc::new(Self { db: Mutex::new(db), store }))
    }

    pub fn with_db<T>(&self, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let db = self.db.lock().expect("engine db mutex poisoned");
        f(&db)
    }

    pub fn add_monitor(&self, root: &Path, interval_secs: i64, source: &str) -> Result<i64> {
        self.with_db(|db| db.add_monitor(&root.to_string_lossy(), interval_secs, source, now()))
    }

    /// Builds a manifest of the monitor's tree and records a snapshot, then
    /// prunes. Returns `Ok(None)` when the tree is unchanged since the last one.
    pub fn snapshot_now(&self, monitor_id: i64, trigger: &str) -> Result<Option<i64>> {
        let db = self.db.lock().expect("engine db mutex poisoned");
        let root: String = db.conn.query_row(
            "SELECT root_path FROM monitors WHERE id = ?1",
            [monitor_id],
            |r| r.get(0),
        )?;
        let s = db.settings()?;

        let manifest = build_manifest(Path::new(&root), &self.store, &s.ignore_globs, s.respect_gitignore)?;
        let ts = now();
        let created = create_snapshot(
            &db,
            &self.store,
            SnapshotInput { monitor_id, trigger: trigger.to_string(), ts, manifest },
        )?;
        prune(&db, &self.store, ts)?;
        Ok(created)
    }

    pub fn list_monitors(&self) -> Result<Vec<query::MonitorRow>> {
        self.with_db(|db| query::list_monitors(db))
    }

    pub fn list_snapshots(&self, monitor_id: i64) -> Result<Vec<query::SnapshotRow>> {
        self.with_db(|db| query::list_snapshots(db, monitor_id))
    }

    pub fn previous_snapshot(&self, snapshot_id: i64) -> Result<Option<i64>> {
        self.with_db(|db| query::previous_snapshot(db, snapshot_id))
    }

    pub fn changed_files(&self, from: i64, to: i64) -> Result<Vec<query::FileChange>> {
        self.with_db(|db| query::changed_files(db, &self.store, from, to))
    }

    pub fn snapshot_files(&self, snapshot_id: i64) -> Result<Vec<String>> {
        self.with_db(|db| query::snapshot_paths(db, &self.store, snapshot_id))
    }

    /// Sets (or clears, when empty) a user label on a breaking point.
    pub fn set_snapshot_label(&self, snapshot_id: i64, label: &str) -> Result<()> {
        self.with_db(|db| {
            let value = if label.trim().is_empty() { None } else { Some(label.trim()) };
            db.conn
                .execute("UPDATE snapshots SET label = ?1 WHERE id = ?2", (value, snapshot_id))?;
            Ok(())
        })
    }

    /// Deletes one breaking point and frees any blobs it solely referenced.
    pub fn delete_snapshot(&self, snapshot_id: i64) -> Result<()> {
        self.with_db(|db| crate::store::delete_snapshot(db, &self.store, snapshot_id))
    }

    /// Removes a monitor and all its history (snapshots deleted individually so
    /// blob refcounts are decremented and orphans GC'd before the row is gone).
    pub fn remove_monitor(&self, monitor_id: i64) -> Result<()> {
        let ids: Vec<i64> = self.with_db(|db| {
            let mut stmt = db.conn.prepare("SELECT id FROM snapshots WHERE monitor_id = ?1")?;
            let rows = stmt.query_map([monitor_id], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
        })?;
        for id in ids {
            self.delete_snapshot(id)?;
        }
        self.with_db(|db| {
            db.conn.execute("DELETE FROM monitors WHERE id = ?1", [monitor_id])?;
            Ok(())
        })
    }

    pub fn file_at(&self, snapshot_id: i64, path: &str) -> Result<Option<Vec<u8>>> {
        self.with_db(|db| query::file_at(db, &self.store, snapshot_id, path))
    }

    /// Hunks between the file as it is on disk now and as captured in the
    /// snapshot — the units the UI offers for selective revert.
    pub fn file_hunks(&self, snapshot_id: i64, path: &str) -> Result<Vec<revert::HunkInfo>> {
        let target = self.file_at(snapshot_id, path)?.unwrap_or_default();
        let root = self.with_db(|db| monitor_root_for_snapshot(db, snapshot_id))?;
        let current = std::fs::read(root.join(path)).unwrap_or_default();
        Ok(revert::hunks(
            &String::from_utf8_lossy(&current),
            &String::from_utf8_lossy(&target),
        ))
    }

    pub fn monitor_root_path(&self, monitor_id: i64) -> Result<String> {
        self.with_db(|db| Ok(monitor_root(db, monitor_id)?.to_string_lossy().into_owned()))
    }

    /// Reads a file as it currently exists in the monitor's working tree.
    pub fn working_file(&self, monitor_id: i64, path: &str) -> Result<Option<String>> {
        let root = self.with_db(|db| monitor_root(db, monitor_id))?;
        Ok(std::fs::read(root.join(path))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub fn set_all_monitor_intervals(&self, secs: i64) -> Result<()> {
        self.with_db(|db| {
            db.conn.execute("UPDATE monitors SET interval_secs = ?1", [secs])?;
            Ok(())
        })
    }

    /// Writes new content to a file in the monitor's working tree (used by the
    /// in-diff per-block revert / edit). The filesystem watcher captures the
    /// result as a new breaking point automatically.
    pub fn write_working_file(&self, monitor_id: i64, path: &str, content: &str) -> Result<()> {
        let root = self.with_db(|db| monitor_root(db, monitor_id))?;
        let dest = root.join(path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(dest, content)?;
        Ok(())
    }

    pub fn deactivate_monitor(&self, monitor_id: i64) -> Result<()> {
        self.set_monitor_active(monitor_id, false)
    }

    pub fn set_monitor_active(&self, monitor_id: i64, active: bool) -> Result<()> {
        self.with_db(|db| {
            db.conn.execute(
                "UPDATE monitors SET active = ?1 WHERE id = ?2",
                (active as i64, monitor_id),
            )?;
            Ok(())
        })
    }

    pub fn get_settings(&self) -> Result<crate::db::Settings> {
        self.with_db(|db| db.settings())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with_db(|db| db.set_setting(key, value))
    }

    pub fn revert_file(&self, snapshot_id: i64, path: &str) -> Result<()> {
        let root = self.pre_revert(snapshot_id)?;
        let content = self.file_at(snapshot_id, path)?;
        revert::apply_file(&root, path, content.as_deref())
    }

    pub fn revert_hunks(&self, snapshot_id: i64, path: &str, selected: &[usize]) -> Result<()> {
        let root = self.pre_revert(snapshot_id)?;
        let target = self.file_at(snapshot_id, path)?.unwrap_or_default();
        let current = std::fs::read(root.join(path)).unwrap_or_default();
        let (out, _) = revert::apply_hunks(
            &String::from_utf8_lossy(&current),
            &String::from_utf8_lossy(&target),
            selected,
        );
        revert::apply_file(&root, path, Some(out.as_bytes()))
    }

    /// Restores every file under `prefix` to the snapshot's state. When
    /// `remove_extraneous` is set, files present on disk but absent from the
    /// snapshot are deleted (the destructive choice is made by the caller).
    pub fn revert_folder(&self, snapshot_id: i64, prefix: &str, remove_extraneous: bool) -> Result<()> {
        let root = self.pre_revert(snapshot_id)?;
        let manifest = self.with_db(|db| query::load_manifest(db, &self.store, snapshot_id))?;
        let under = |p: &str| prefix.is_empty() || p == prefix || p.starts_with(&format!("{prefix}/"));

        let mut kept = std::collections::HashSet::new();
        for e in &manifest.entries {
            if under(&e.path) {
                let content = self.store.get(&e.hash)?;
                revert::apply_file(&root, &e.path, Some(&content))?;
                kept.insert(e.path.clone());
            }
        }
        if remove_extraneous {
            let s = self.get_settings()?;
            for p in crate::ignore::list_paths(&root, &s.ignore_globs, s.respect_gitignore)? {
                if under(&p) && !kept.contains(&p) {
                    revert::apply_file(&root, &p, None)?;
                }
            }
        }
        Ok(())
    }

    /// Safety snapshot taken before any revert so the revert is itself
    /// reversible; returns the monitor's working-tree root.
    fn pre_revert(&self, snapshot_id: i64) -> Result<PathBuf> {
        let monitor_id = self.with_db(|db| monitor_id_of(db, snapshot_id))?;
        self.snapshot_now(monitor_id, "pre_revert")?;
        self.with_db(|db| monitor_root(db, monitor_id))
    }

    pub fn store(&self) -> &BlobStore {
        &self.store
    }

    pub fn data_root(&self) -> PathBuf {
        // store objects dir lives under data_dir; expose for diagnostics
        self.store.objects_dir().to_path_buf()
    }
}

fn monitor_id_of(db: &Db, snapshot_id: i64) -> Result<i64> {
    Ok(db.conn.query_row(
        "SELECT monitor_id FROM snapshots WHERE id = ?1",
        [snapshot_id],
        |r| r.get(0),
    )?)
}

fn monitor_root(db: &Db, monitor_id: i64) -> Result<PathBuf> {
    let root: String = db.conn.query_row(
        "SELECT root_path FROM monitors WHERE id = ?1",
        [monitor_id],
        |r| r.get(0),
    )?;
    Ok(PathBuf::from(root))
}

fn monitor_root_for_snapshot(db: &Db, snapshot_id: i64) -> Result<PathBuf> {
    monitor_root(db, monitor_id_of(db, snapshot_id)?)
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

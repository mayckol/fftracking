use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::git;
use crate::ignore::build_manifest;
use crate::query::{ChangeStatus, FileChange};
use crate::store::prune::prune;
use crate::store::{create_snapshot, BlobStore, SnapshotInput};
use crate::{query, revert, Db, Error, Result};

/// App-facing core: owns the metadata DB and blob store and turns "snapshot
/// this monitor now" requests into deduped snapshots, pruning afterwards.
pub struct Engine {
    db: Mutex<Db>,
    store: BlobStore,
}

/// What a monitor's breaking points are compared against: the current git
/// branch when the folder is a repo, otherwise the preceding breaking point.
#[derive(Debug, Clone, Serialize)]
pub struct BaseInfo {
    pub kind: String, // "git" | "snapshot"
    pub branch: Option<String>,
    pub repo_root: Option<String>,
    pub head: Option<String>,
}

/// Per-breaking-point tally of how it differs from its base — drives the
/// timeline's change badges.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeSummary {
    pub id: i64,
    pub added: i64,
    pub modified: i64,
    pub deleted: i64,
}

type PathMap = BTreeMap<String, String>;

fn not_git() -> Error {
    Error::Msg("this folder is not inside a git repository".into())
}

fn diff_maps(base: &PathMap, target: &PathMap) -> Vec<FileChange> {
    let mut out = Vec::new();
    for (path, hash) in target {
        match base.get(path) {
            None => out.push(FileChange { path: path.clone(), status: ChangeStatus::Added }),
            Some(h) if h != hash => {
                out.push(FileChange { path: path.clone(), status: ChangeStatus::Modified })
            }
            _ => {}
        }
    }
    for path in base.keys() {
        if !target.contains_key(path) {
            out.push(FileChange { path: path.clone(), status: ChangeStatus::Deleted });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
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

    /// A monitor's working root paired with its git context, or `None` when the
    /// folder is not a usable git monitor. Resolved without holding the db lock.
    fn git_context(&self, monitor_id: i64) -> Result<Option<(PathBuf, git::GitInfo)>> {
        let root = self.with_db(|db| monitor_root(db, monitor_id))?;
        Ok(git::repo_info(&root).map(|g| (root, g)))
    }

    fn git_info(&self, monitor_id: i64) -> Result<Option<git::GitInfo>> {
        Ok(self.git_context(monitor_id)?.map(|(_, g)| g))
    }

    /// Whether a monitor's breaking points diff against the git branch or the
    /// previous point. `head` (current HEAD oid) lets the UI notice a moved
    /// branch and refresh without a snapshot-set change.
    pub fn base_info(&self, monitor_id: i64) -> Result<BaseInfo> {
        Ok(match self.git_info(monitor_id)? {
            Some(g) => BaseInfo {
                kind: "git".into(),
                branch: Some(g.branch),
                repo_root: Some(g.repo_root),
                head: g.head,
            },
            None => BaseInfo { kind: "snapshot".into(), branch: None, repo_root: None, head: None },
        })
    }

    /// HEAD path→hash map for a git monitor, with the monitor's own capture
    /// exclusions applied so it matches the snapshot side of the diff exactly
    /// (no phantom deletions from globs/.gitignore/submodules).
    fn head_hashes(&self, root: &Path, g: &git::GitInfo) -> Result<PathMap> {
        let s = self.get_settings()?;
        let filter = crate::ignore::PathFilter::build(root, &s.ignore_globs, s.respect_gitignore)?;
        let mut map: PathMap = git::head_files(Path::new(&g.repo_root), &g.prefix, &filter)?
            .iter()
            .map(|(p, c)| (p.clone(), BlobStore::hash(c)))
            .collect();
        map.retain(|p, _| !g.under_submodule(p));
        Ok(map)
    }

    fn manifest_map(&self, snapshot_id: i64) -> Result<PathMap> {
        let manifest = self.with_db(|db| query::load_manifest(db, &self.store, snapshot_id))?;
        Ok(manifest.entries.into_iter().map(|e| (e.path, e.hash)).collect())
    }

    /// A snapshot's manifest map with submodule working-tree files removed —
    /// their contents belong to nested repos, not this one's HEAD.
    fn target_map(&self, snapshot_id: i64, g: Option<&git::GitInfo>) -> Result<PathMap> {
        let mut m = self.manifest_map(snapshot_id)?;
        if let Some(g) = g {
            m.retain(|p, _| !g.under_submodule(p));
        }
        Ok(m)
    }

    /// Files that differ between a breaking point and its base (git branch or
    /// previous point) — the tiered replacement for raw `changed_files`.
    pub fn breaking_point_changes(&self, monitor_id: i64, snapshot_id: i64) -> Result<Vec<FileChange>> {
        match self.git_context(monitor_id)? {
            Some((root, g)) => {
                let base = self.head_hashes(&root, &g)?;
                let target = self.target_map(snapshot_id, Some(&g))?;
                Ok(diff_maps(&base, &target))
            }
            None => {
                let base = match self.previous_snapshot(snapshot_id)? {
                    Some(prev) => self.manifest_map(prev)?,
                    None => PathMap::new(),
                };
                Ok(diff_maps(&base, &self.manifest_map(snapshot_id)?))
            }
        }
    }

    /// The base-side content of a file for the breaking point's diff: the git
    /// HEAD version in a repo, else the file as captured in the previous point.
    pub fn base_file(&self, monitor_id: i64, snapshot_id: i64, path: &str) -> Result<Option<Vec<u8>>> {
        match self.git_info(monitor_id)? {
            Some(g) => git::head_blob_at(Path::new(&g.repo_root), &g.prefix, path),
            None => match self.previous_snapshot(snapshot_id)? {
                Some(prev) => self.file_at(prev, path),
                None => Ok(None),
            },
        }
    }

    /// Added/modified/deleted counts for every breaking point of a monitor,
    /// each against its base. The base is read once, so this stays one pass.
    pub fn snapshot_change_summaries(&self, monitor_id: i64) -> Result<Vec<ChangeSummary>> {
        let git = self.git_context(monitor_id)?;
        let ids: Vec<i64> = self.with_db(|db| {
            let mut stmt = db
                .conn
                .prepare("SELECT id FROM snapshots WHERE monitor_id = ?1 ORDER BY ts ASC, id ASC")?;
            let rows = stmt.query_map([monitor_id], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
        })?;

        let g_ref = git.as_ref().map(|(_, g)| g);
        let maps: Vec<PathMap> =
            ids.iter().map(|id| self.target_map(*id, g_ref)).collect::<Result<_>>()?;

        let head_map: Option<PathMap> = match &git {
            Some((root, g)) => Some(self.head_hashes(root, g)?),
            None => None,
        };
        let empty = PathMap::new();

        let mut out = Vec::with_capacity(ids.len());
        for (i, id) in ids.iter().enumerate() {
            let base = match &head_map {
                Some(h) => h,
                None if i == 0 => &empty,
                None => &maps[i - 1],
            };
            let changes = diff_maps(base, &maps[i]);
            let count = |s: ChangeStatus| changes.iter().filter(|c| c.status == s).count() as i64;
            out.push(ChangeSummary {
                id: *id,
                added: count(ChangeStatus::Added),
                modified: count(ChangeStatus::Modified),
                deleted: count(ChangeStatus::Deleted),
            });
        }
        Ok(out)
    }

    /// Resets one working-tree file to its current-branch (HEAD) version,
    /// recreating it if deleted or removing it if not committed. Takes a safety
    /// snapshot first, like every other revert.
    pub fn git_reset_file(&self, monitor_id: i64, path: &str) -> Result<()> {
        let (root, g) = self.git_context(monitor_id)?.ok_or_else(not_git)?;
        if g.under_submodule(path) {
            return Err(Error::Msg("file belongs to a git submodule; reset it from its own repo".into()));
        }
        self.snapshot_now(monitor_id, "pre_revert")?;
        let content = git::head_blob_at(Path::new(&g.repo_root), &g.prefix, path)?;
        revert::apply_file(&root, path, content.as_deref())
    }

    /// Resets every file under `prefix` to its current-branch (HEAD) version.
    /// With `remove_extraneous`, files present on disk but not committed under
    /// the branch are deleted (the destructive choice the caller opts into) —
    /// but never a file git still tracks (e.g. one dropped for exceeding the
    /// size cap) nor anything inside a submodule.
    pub fn git_reset_folder(&self, monitor_id: i64, prefix: &str, remove_extraneous: bool) -> Result<()> {
        let (root, g) = self.git_context(monitor_id)?.ok_or_else(not_git)?;
        self.snapshot_now(monitor_id, "pre_revert")?;
        let s = self.get_settings()?;
        let repo = Path::new(&g.repo_root);
        let filter = crate::ignore::PathFilter::build(&root, &s.ignore_globs, s.respect_gitignore)?;
        let head = git::head_files(repo, &g.prefix, &filter)?;
        let under = |p: &str| prefix.is_empty() || p == prefix || p.starts_with(&format!("{prefix}/"));

        let mut kept: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (rel, content) in &head {
            if under(rel) && !g.under_submodule(rel) {
                revert::apply_file(&root, rel, Some(content))?;
                kept.insert(rel.clone());
            }
        }
        if remove_extraneous {
            for p in crate::ignore::list_paths(&root, &s.ignore_globs, s.respect_gitignore)? {
                if under(&p)
                    && !kept.contains(&p)
                    && !g.under_submodule(&p)
                    && git::head_blob_at(repo, &g.prefix, &p)?.is_none()
                {
                    revert::apply_file(&root, &p, None)?;
                }
            }
        }
        Ok(())
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

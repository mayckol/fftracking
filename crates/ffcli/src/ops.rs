//! Operations shared by the CLI and the MCP server. Each returns a JSON value
//! so the `--json` flag and the MCP `tools/call` handler emit identical data;
//! the CLI's human renderer formats the same value for terminals.

use std::path::{Path, PathBuf};

use ffcore::Engine;
use serde_json::{json, Value};

pub type OpResult = Result<Value, String>;

fn e<T>(r: ffcore::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// Data directory shared with the desktop app (so CLI/agent actions appear in
/// the GUI and vice versa). Override with `FFTRACKING_DATA_DIR`.
pub fn default_data_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("FFTRACKING_DATA_DIR") {
        return Ok(PathBuf::from(d));
    }
    const ID: &str = "com.fftracking.app";
    let base = platform_data_root().ok_or("could not resolve a data directory; set FFTRACKING_DATA_DIR")?;
    Ok(base.join(ID))
}

#[cfg(target_os = "macos")]
fn platform_data_root() -> Option<PathBuf> {
    Some(home()?.join("Library/Application Support"))
}

#[cfg(target_os = "linux")]
fn platform_data_root() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| Some(home()?.join(".local/share")))
}

#[cfg(target_os = "windows")]
fn platform_data_root() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_data_root() -> Option<PathBuf> {
    Some(home()?.join(".fftracking"))
}

#[allow(dead_code)]
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Resolves a tracked folder to its monitor id, matching on the canonical path.
pub fn resolve_monitor(engine: &Engine, path: &Path) -> Result<i64, String> {
    let want = canon(path);
    for m in e(engine.list_monitors())? {
        if canon(Path::new(&m.root_path)) == want {
            return Ok(m.id);
        }
    }
    Err(format!(
        "{} is not tracked — run `fft track --path {}` first",
        path.display(),
        path.display()
    ))
}

fn latest_point(engine: &Engine, monitor_id: i64) -> Result<i64, String> {
    e(engine.list_snapshots(monitor_id))?
        .first()
        .map(|s| s.id)
        .ok_or_else(|| "this folder has no breaking points yet".to_string())
}

pub fn track(engine: &Engine, path: &Path, interval: i64) -> OpResult {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let id = e(engine.add_monitor(path, interval, "manual"))?;
    let created = e(engine.snapshot_now(id, "manual"))?;
    Ok(json!({ "id": id, "path": path.to_string_lossy(), "interval_secs": interval, "initial_point": created }))
}

pub fn snapshot(engine: &Engine, path: &Path, label: Option<&str>) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    let created = e(engine.snapshot_now(id, "manual"))?;
    if let (Some(point), Some(text)) = (created, label) {
        e(engine.set_snapshot_label(point, text))?;
    }
    Ok(json!({
        "monitor_id": id,
        "created": created.is_some(),
        "point": created,
        "label": label,
    }))
}

pub fn list(engine: &Engine) -> OpResult {
    let mut out = Vec::new();
    for m in e(engine.list_monitors())? {
        let base = e(engine.base_info(m.id))?;
        out.push(json!({
            "id": m.id,
            "path": m.root_path,
            "active": m.active,
            "interval_secs": m.interval_secs,
            "source": m.source,
            "base": { "kind": base.kind, "branch": base.branch },
        }));
    }
    Ok(Value::Array(out))
}

pub fn points(engine: &Engine, path: &Path, limit: usize) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    let rows = e(engine.list_snapshots(id))?;
    let sums = e(engine.snapshot_change_summaries(id))?;
    let by_id: std::collections::HashMap<i64, _> = sums.into_iter().map(|s| (s.id, s)).collect();
    let out: Vec<Value> = rows
        .into_iter()
        .take(limit)
        .map(|r| {
            let s = by_id.get(&r.id);
            json!({
                "id": r.id,
                "ts": r.ts,
                "trigger": r.trigger,
                "label": r.label,
                "files": r.file_count,
                "added": s.map(|s| s.added).unwrap_or(0),
                "modified": s.map(|s| s.modified).unwrap_or(0),
                "deleted": s.map(|s| s.deleted).unwrap_or(0),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub fn changes(engine: &Engine, path: &Path, point: Option<i64>) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    let point = match point {
        Some(p) => p,
        None => latest_point(engine, id)?,
    };
    let base = e(engine.base_info(id))?;
    let files = e(engine.breaking_point_changes(id, point))?;
    Ok(json!({
        "monitor_id": id,
        "point": point,
        "base": { "kind": base.kind, "branch": base.branch },
        "files": serde_json::to_value(files).map_err(|e| e.to_string())?,
    }))
}

pub fn diff(engine: &Engine, path: &Path, file: &str, point: Option<i64>, now: bool) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    let point = match point {
        Some(p) => p,
        None => latest_point(engine, id)?,
    };
    let base = e(engine.base_info(id))?;
    let (left, right, left_label, right_label) = if now {
        let l = e(engine.file_at(point, file))?.map(bytes_to_string).unwrap_or_default();
        let r = e(engine.working_file(id, file))?.unwrap_or_default();
        (l, r, format!("point {point}"), "working tree".to_string())
    } else {
        let l = e(engine.base_file(id, point, file))?.map(bytes_to_string).unwrap_or_default();
        let r = e(engine.file_at(point, file))?.map(bytes_to_string).unwrap_or_default();
        let ll = if base.kind == "git" { base.branch.clone().unwrap_or_else(|| "HEAD".into()) } else { "previous point".into() };
        (l, r, ll, format!("point {point}"))
    };
    let udiff = similar::TextDiff::from_lines(&left, &right)
        .unified_diff()
        .header(&left_label, &right_label)
        .to_string();
    Ok(json!({
        "monitor_id": id,
        "point": point,
        "file": file,
        "from": left_label,
        "to": right_label,
        "diff": udiff,
    }))
}

pub fn revert(engine: &Engine, path: &Path, point: i64, file: Option<&str>, all: bool) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    match (file, all) {
        (Some(f), _) => {
            e(engine.revert_file(point, f))?;
            Ok(json!({ "monitor_id": id, "point": point, "reverted": [f] }))
        }
        (None, true) => {
            e(engine.revert_folder(point, "", false))?;
            Ok(json!({ "monitor_id": id, "point": point, "reverted": "all files" }))
        }
        (None, false) => Err("specify --file <path> or --all".into()),
    }
}

pub fn reset(engine: &Engine, path: &Path, file: Option<&str>, all: bool, remove_extraneous: bool) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    let base = e(engine.base_info(id))?;
    if base.kind != "git" {
        return Err("reset-to-branch needs a git repo; use `fft revert` for non-git folders".into());
    }
    match (file, all) {
        (Some(f), _) => {
            e(engine.git_reset_file(id, f))?;
            Ok(json!({ "monitor_id": id, "branch": base.branch, "reset": [f] }))
        }
        (None, true) => {
            e(engine.git_reset_folder(id, "", remove_extraneous))?;
            Ok(json!({ "monitor_id": id, "branch": base.branch, "reset": "all files", "removed_extraneous": remove_extraneous }))
        }
        (None, false) => Err("specify --file <path> or --all".into()),
    }
}

pub fn label(engine: &Engine, path: &Path, point: i64, text: &str) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    e(engine.set_snapshot_label(point, text))?;
    Ok(json!({ "monitor_id": id, "point": point, "label": text }))
}

pub fn untrack(engine: &Engine, path: &Path, purge: bool) -> OpResult {
    let id = resolve_monitor(engine, path)?;
    if purge {
        e(engine.remove_monitor(id))?;
        Ok(json!({ "monitor_id": id, "removed": true, "history_deleted": true }))
    } else {
        e(engine.deactivate_monitor(id))?;
        Ok(json!({ "monitor_id": id, "stopped": true, "history_deleted": false }))
    }
}

fn bytes_to_string(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).into_owned()
}

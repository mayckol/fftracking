use std::path::PathBuf;

use ffcore::db::Settings;
use ffcore::detect::{detect_workspaces, DetectedWorkspace};
use ffcore::git::{self, GitFileChange, RefList};
use ffcore::query::{FileChange, MonitorRow, SnapshotRow};
use ffcore::revert::HunkInfo;
use ffcore::sysmon::ResourceUsage;
use tauri::State;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::AppState;

type R<T> = Result<T, String>;

fn err<T>(r: ffcore::Result<T>) -> R<T> {
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_monitor(state: State<AppState>, path: String, interval_secs: i64) -> R<i64> {
    let root = PathBuf::from(&path);
    let id = err(state.engine.add_monitor(&root, interval_secs, "manual"))?;
    err(state.engine.snapshot_now(id, "manual"))?;
    err(state.manager.start(id, &root, interval_secs))?;
    Ok(id)
}

#[tauri::command]
pub fn list_monitors(state: State<AppState>) -> R<Vec<MonitorRow>> {
    err(state.engine.list_monitors())
}

#[tauri::command]
pub fn start_monitor(state: State<AppState>, monitor_id: i64) -> R<()> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let interval = err(state.engine.get_settings())?.default_interval_secs;
    err(state.manager.start(monitor_id, &root, interval))?;
    err(state.engine.set_monitor_active(monitor_id, true))?;
    err(state.engine.snapshot_now(monitor_id, "manual"))?;
    Ok(())
}

#[tauri::command]
pub fn stop_monitor(state: State<AppState>, monitor_id: i64) -> R<()> {
    state.manager.stop(monitor_id);
    err(state.engine.deactivate_monitor(monitor_id))
}

#[tauri::command]
pub fn snapshot_now(state: State<AppState>, monitor_id: i64) -> R<Option<i64>> {
    err(state.engine.snapshot_now(monitor_id, "manual"))
}

#[tauri::command]
pub fn remove_monitor(state: State<AppState>, monitor_id: i64) -> R<()> {
    state.manager.stop(monitor_id);
    err(state.engine.remove_monitor(monitor_id))
}

#[tauri::command]
pub fn delete_snapshot(state: State<AppState>, snapshot_id: i64) -> R<()> {
    err(state.engine.delete_snapshot(snapshot_id))
}

#[tauri::command]
pub fn set_snapshot_label(state: State<AppState>, snapshot_id: i64, label: String) -> R<()> {
    err(state.engine.set_snapshot_label(snapshot_id, &label))
}

#[tauri::command]
pub fn list_snapshots(state: State<AppState>, monitor_id: i64) -> R<Vec<SnapshotRow>> {
    err(state.engine.list_snapshots(monitor_id))
}

#[tauri::command]
pub fn previous_snapshot(state: State<AppState>, snapshot_id: i64) -> R<Option<i64>> {
    err(state.engine.previous_snapshot(snapshot_id))
}

#[tauri::command]
pub fn changed_files(state: State<AppState>, from: i64, to: i64) -> R<Vec<FileChange>> {
    err(state.engine.changed_files(from, to))
}

#[tauri::command]
pub fn snapshot_files(state: State<AppState>, snapshot_id: i64) -> R<Vec<String>> {
    err(state.engine.snapshot_files(snapshot_id))
}

#[tauri::command]
pub fn file_at(state: State<AppState>, snapshot_id: i64, path: String) -> R<Option<String>> {
    Ok(err(state.engine.file_at(snapshot_id, &path))?
        .map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
pub fn working_file(state: State<AppState>, monitor_id: i64, path: String) -> R<Option<String>> {
    err(state.engine.working_file(monitor_id, &path))
}

#[tauri::command]
pub fn write_working_file(state: State<AppState>, monitor_id: i64, path: String, content: String) -> R<()> {
    err(state.engine.write_working_file(monitor_id, &path, &content))
}

#[tauri::command]
pub fn file_hunks(state: State<AppState>, snapshot_id: i64, path: String) -> R<Vec<HunkInfo>> {
    err(state.engine.file_hunks(snapshot_id, &path))
}

/// Hunks of the displayed diff (left vs right). Positioned on the right side so
/// the revert icon lines up with every shown change.
#[tauri::command]
pub fn text_hunks(left: String, right: String) -> Vec<HunkInfo> {
    ffcore::revert::hunks(&right, &left)
}

/// Reverts selected blocks of the displayed diff toward the left side and writes
/// the result to the working tree (undo-this-change / restore-to-point).
#[tauri::command]
pub fn apply_text_revert(
    state: State<AppState>,
    monitor_id: i64,
    path: String,
    left: String,
    right: String,
    selected: Vec<usize>,
) -> R<()> {
    let (out, _) = ffcore::revert::apply_hunks(&right, &left, &selected);
    err(state.engine.write_working_file(monitor_id, &path, &out))
}

#[tauri::command]
pub fn revert_file(state: State<AppState>, snapshot_id: i64, path: String) -> R<()> {
    err(state.engine.revert_file(snapshot_id, &path))
}

#[tauri::command]
pub fn revert_folder(state: State<AppState>, snapshot_id: i64, prefix: String, remove_extraneous: bool) -> R<()> {
    err(state.engine.revert_folder(snapshot_id, &prefix, remove_extraneous))
}

#[tauri::command]
pub fn revert_hunks(state: State<AppState>, snapshot_id: i64, path: String, selected: Vec<usize>) -> R<()> {
    err(state.engine.revert_hunks(snapshot_id, &path, &selected))
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> R<Settings> {
    err(state.engine.get_settings())
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> R<()> {
    err(state.engine.set_setting(&key, &value))?;
    // Apply a new interval to existing monitors immediately by restarting their
    // watchers with the new cadence (otherwise it only affects folders added later).
    if key == "default_interval_secs" {
        if let Ok(secs) = value.parse::<i64>() {
            err(state.engine.set_all_monitor_intervals(secs))?;
            for m in err(state.engine.list_monitors())? {
                state.manager.stop(m.id);
                if m.active {
                    err(state.manager.start(m.id, &PathBuf::from(&m.root_path), secs))?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn detected_workspaces() -> Vec<DetectedWorkspace> {
    detect_workspaces()
}

#[tauri::command]
pub fn git_list_refs(repo_path: String) -> R<RefList> {
    err(git::list_refs(&PathBuf::from(repo_path), 100))
}

#[tauri::command]
pub fn git_changed_files(repo_path: String, from: String, to: String) -> R<Vec<GitFileChange>> {
    err(git::changed_files(&PathBuf::from(repo_path), &from, &to))
}

#[tauri::command]
pub fn git_file(repo_path: String, rev: String, path: String) -> R<Option<String>> {
    Ok(err(git::file_at_rev(&PathBuf::from(repo_path), &rev, &path))?
        .map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
pub fn git_file_hunks(repo_path: String, from: String, to: String, path: String) -> R<Vec<HunkInfo>> {
    err(git::file_hunks(&PathBuf::from(repo_path), &from, &to, &path))
}

#[tauri::command]
pub fn git_revert_hunks(repo_path: String, from: String, to: String, path: String, selected: Vec<usize>) -> R<()> {
    err(git::revert_hunks(&PathBuf::from(repo_path), &from, &to, &path, &selected))
}

#[tauri::command]
pub fn git_write_working(repo_path: String, path: String, content: String) -> R<()> {
    err(git::write_working(&PathBuf::from(repo_path), &path, &content))
}

#[tauri::command]
pub fn git_conflicts(repo_path: String) -> R<Vec<String>> {
    err(git::conflicted_paths(&PathBuf::from(repo_path)))
}

#[tauri::command]
pub fn git_resolve_conflict(repo_path: String, path: String, content: String) -> R<()> {
    err(git::resolve_conflict(&PathBuf::from(repo_path), &path, &content))
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> R<()> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn autostart_enabled(app: tauri::AppHandle) -> R<bool> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resource_usage(state: State<AppState>) -> ResourceUsage {
    state.sysmon.lock().expect("sysmon mutex poisoned").sample()
}

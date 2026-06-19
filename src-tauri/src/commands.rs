use std::path::{Path, PathBuf};

use ffcore::db::Settings;
use ffcore::detect::{detect_workspaces, DetectedWorkspace};
use ffcore::engine::{BaseInfo, ChangeSummary};
use ffcore::git::{self, GitFileChange, RefList, WorkingStatus};
use ffcore::query::{FileChange, MonitorRow, SnapshotRow};
use ffcore::revert::HunkInfo;
use ffcore::sysmon::ResourceUsage;
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::dap::DapManager;
use crate::lsp::LspManager;
use crate::run::RunManager;
use crate::terminal::TerminalManager;
use crate::AppState;

type R<T> = Result<T, String>;

fn err<T>(r: ffcore::Result<T>) -> R<T> {
    r.map_err(|e| e.to_string())
}

// Adds (or re-activates) a monitor for `root` and makes it the sole captured
// project, returning its id. Shared by the `add_monitor` command and the CLI
// launcher (`fftrack <path>`).
pub fn activate_monitor(state: &AppState, root: &Path, interval_secs: i64) -> ffcore::Result<i64> {
    let id = state.engine.add_monitor(root, interval_secs, "manual")?;
    // Exclusive monitoring: the freshly added (or re-added) project becomes the
    // only one captured. Stop every other monitor before this one starts, so
    // there is never a window with two live capture threads.
    for m in state.engine.list_monitors()? {
        if m.id == id {
            continue;
        }
        state.manager.stop(m.id);
        if m.active {
            state.engine.deactivate_monitor(m.id)?;
        }
    }
    state.engine.snapshot_now(id, "manual")?;
    state.manager.start(id, root, interval_secs)?;
    Ok(id)
}

#[tauri::command]
pub fn add_monitor(state: State<AppState>, path: String, interval_secs: i64) -> R<i64> {
    err(activate_monitor(&state, &PathBuf::from(&path), interval_secs))
}

#[tauri::command]
pub fn take_pending_open(state: State<AppState>) -> Option<i64> {
    state.pending_open.lock().ok().and_then(|mut g| g.take())
}

// Installs a `fftrack` shim on PATH so `fftrack <path>` opens that project,
// VSCode-`code`-style. Writes to the first writable of /usr/local/bin or
// ~/.local/bin and returns the script path.
#[tauri::command]
pub fn install_cli() -> R<String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Background + detach so the terminal returns immediately; a second
    // invocation while running is forwarded by the single-instance plugin.
    let script = format!("#!/bin/sh\nnohup \"{}\" \"$@\" >/dev/null 2>&1 &\n", exe.display());

    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin"));
    }
    let mut last_err = String::from("no writable bin directory found");
    for dir in candidates {
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let dest = dir.join("fftrack");
        match std::fs::write(&dest, &script) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                }
                return Ok(dest.to_string_lossy().to_string());
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

// How this running build was installed, so the UI can offer the right update
// path (and hide updates for dev builds).
#[tauri::command]
pub fn install_method() -> String {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    if exe.contains("/target/debug/") || exe.contains("/target/release/") {
        "dev".into()
    } else if exe.contains("/Applications/fftracking.app/") {
        "dmg".into()
    } else if exe.to_lowercase().ends_with(".appimage") || std::env::var_os("APPIMAGE").is_some() {
        "appimage".into()
    } else {
        "unknown".into()
    }
}

// Re-runs the curl installer in a visible terminal: it re-detects OS/arch and
// replaces the app + CLIs in place. A terminal (not a silent spawn) so the user
// sees progress and can authorize a privileged copy if /Applications needs it.
#[tauri::command]
pub fn run_update() -> R<()> {
    if install_method() == "dev" {
        return Err("This is a development build — update via your build toolchain.".into());
    }
    let cmd = "curl -fsSL https://raw.githubusercontent.com/mayckol/fftracking/main/scripts/install.sh | sh";

    #[cfg(target_os = "macos")]
    {
        let osa = format!(
            "tell application \"Terminal\"\n  activate\n  do script \"{cmd} && echo && echo 'Updated — reopen fftracking.'\"\nend tell"
        );
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(osa)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let inner =
            format!("{cmd}; echo; echo 'Updated — reopen fftracking.'; echo 'Press Enter to close…'; read _");
        // -e takes the command as separate args for most emulators; gnome-terminal
        // wants it after `--`. Try each until one launches.
        let attempts: [(&str, &[&str]); 4] = [
            ("x-terminal-emulator", &["-e", "sh", "-c"]),
            ("gnome-terminal", &["--", "sh", "-c"]),
            ("konsole", &["-e", "sh", "-c"]),
            ("xterm", &["-e", "sh", "-c"]),
        ];
        for (term, pre) in attempts {
            let ok = std::process::Command::new(term)
                .args(pre)
                .arg(&inner)
                .spawn()
                .is_ok();
            if ok {
                return Ok(());
            }
        }
        return Err("no terminal emulator found to run the updater".into());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform".into())
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

// Exclusive monitoring: only the selected project captures. Stops every other
// running monitor (and clears its active flag) before starting the chosen one,
// so the invariant "at most one active monitor" holds across selection, add,
// delete, and restart. `manager.start` is a no-op if already running.
#[tauri::command]
pub fn set_active_monitor(state: State<AppState>, monitor_id: i64) -> R<()> {
    let interval = err(state.engine.get_settings())?.default_interval_secs;
    for m in err(state.engine.list_monitors())? {
        if m.id == monitor_id {
            continue;
        }
        state.manager.stop(m.id);
        if m.active {
            err(state.engine.deactivate_monitor(m.id))?;
        }
    }
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    err(state.manager.start(monitor_id, &root, interval))?;
    err(state.engine.set_monitor_active(monitor_id, true))
}

#[tauri::command]
pub fn snapshot_now(state: State<AppState>, monitor_id: i64) -> R<Option<i64>> {
    err(state.engine.snapshot_now(monitor_id, "manual"))
}

// Async + spawn_blocking: deleting a monitor with a deep history is heavy, and
// a sync command would hold the main thread and freeze the UI for its duration.
#[tauri::command]
pub async fn remove_monitor(state: State<'_, AppState>, monitor_id: i64) -> R<()> {
    state.manager.stop(monitor_id);
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || err(engine.remove_monitor(monitor_id)))
        .await
        .map_err(|e| e.to_string())?
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
pub fn monitor_base_info(state: State<AppState>, monitor_id: i64) -> R<BaseInfo> {
    err(state.engine.base_info(monitor_id))
}

#[tauri::command]
pub fn breaking_point_changes(state: State<AppState>, monitor_id: i64, snapshot_id: i64) -> R<Vec<FileChange>> {
    err(state.engine.breaking_point_changes(monitor_id, snapshot_id))
}

#[tauri::command]
pub fn snapshot_working_changes(state: State<AppState>, monitor_id: i64, snapshot_id: i64) -> R<Vec<FileChange>> {
    err(state.engine.snapshot_working_changes(monitor_id, snapshot_id))
}

#[tauri::command]
pub fn monitor_files(state: State<AppState>, monitor_id: i64) -> R<Vec<String>> {
    err(state.engine.monitor_files(monitor_id))
}

// Async + spawn_blocking: scanning a large tree must not block the main thread
// while the user types in the search box.
#[tauri::command]
pub async fn search_content(
    state: State<'_, AppState>,
    monitor_id: i64,
    options: ffcore::search::SearchOptions,
) -> R<ffcore::search::SearchResults> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || err(engine.search_content(monitor_id, &options)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn replace_match(
    state: State<'_, AppState>,
    monitor_id: i64,
    spec: ffcore::search::ReplaceMatchSpec,
) -> R<usize> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || err(engine.replace_match(monitor_id, &spec)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn replace_all(
    state: State<'_, AppState>,
    monitor_id: i64,
    spec: ffcore::search::ReplaceSpec,
) -> R<ffcore::search::ReplaceSummary> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || err(engine.replace_all(monitor_id, &spec)))
        .await
        .map_err(|e| e.to_string())?
}

fn abs_path(state: &State<AppState>, monitor_id: i64, path: &str) -> R<PathBuf> {
    Ok(PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?).join(path))
}

/// Opens a working-tree file with the OS default application.
#[tauri::command]
pub fn open_path(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    let p = abs_path(&state, monitor_id, &path)?;
    let prog = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(prog).arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveals a working-tree file in the OS file manager (selects it on macOS,
/// opens its parent directory on Linux).
#[tauri::command]
pub fn reveal_path(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    let p = abs_path(&state, monitor_id, &path)?;
    if cfg!(target_os = "macos") {
        std::process::Command::new("open").args(["-R".as_ref(), p.as_os_str()]).spawn()
    } else {
        let dir = p.parent().unwrap_or(&p);
        std::process::Command::new("xdg-open").arg(dir).spawn()
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves a working-tree file or directory to the OS trash (recoverable). Refuses
/// to act outside the monitor root, or on the root itself.
#[tauri::command]
pub fn delete_path(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canon_target = root.join(&path).canonicalize().map_err(|e| e.to_string())?;
    if canon_target == canon_root || !canon_target.starts_with(&canon_root) {
        return Err("refusing to delete outside the tracked folder".into());
    }
    trash::delete(&canon_target).map_err(|e| e.to_string())
}

/// Resolves a *relative* working-tree path that may not exist yet, refusing
/// anything that escapes the monitor root (`..`, absolute paths, symlink
/// breakouts). The parent dir must already resolve inside the root.
fn safe_new_path(root: &std::path::Path, rel: &str) -> R<PathBuf> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err("name cannot be empty".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("path cannot contain '..'".into()),
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err("name cannot be empty".into());
    }
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = canon_root.join(parts.join("/"));
    // Walk the deepest existing ancestor and confirm it stays under the root.
    let mut probe = target.clone();
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => break,
        }
    }
    let canon_probe = probe.canonicalize().map_err(|e| e.to_string())?;
    if !canon_probe.starts_with(&canon_root) {
        return Err("refusing to write outside the tracked folder".into());
    }
    Ok(target)
}

/// Creates an empty file at `path` (relative to the monitor root), making any
/// intermediate folders. `path` may contain `/` so a folder context menu can
/// spawn a whole nested chain (e.g. `database/config/con.go`).
#[tauri::command]
pub fn create_file(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let target = safe_new_path(&root, &path)?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(&target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates an empty folder at `path` (relative to the monitor root).
#[tauri::command]
pub fn create_dir(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let target = safe_new_path(&root, &path)?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())
}

/// Renames/moves a working-tree file or folder. `from` must exist inside the
/// root; `to` is a relative path that also stays inside the root and whose
/// parent dirs are created as needed.
#[tauri::command]
pub fn rename_path(state: State<AppState>, monitor_id: i64, from: String, to: String) -> R<()> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let src = root.join(&from).canonicalize().map_err(|e| e.to_string())?;
    if src == canon_root || !src.starts_with(&canon_root) {
        return Err("refusing to rename outside the tracked folder".into());
    }
    let dest = safe_new_path(&root, &to)?;
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

/// Copies a file or folder beside the original under a non-colliding
/// "<name> copy[ N]" name and returns the new path relative to the root.
#[tauri::command]
pub fn duplicate_path(state: State<AppState>, monitor_id: i64, path: String) -> R<String> {
    let root = PathBuf::from(err(state.engine.monitor_root_path(monitor_id))?);
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let src = root.join(&path).canonicalize().map_err(|e| e.to_string())?;
    if src == canon_root || !src.starts_with(&canon_root) {
        return Err("refusing to copy outside the tracked folder".into());
    }
    let parent = src.parent().ok_or("no parent directory")?;
    let name = src.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut dest = parent.join(format!("{stem} copy{ext}"));
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{stem} copy {n}{ext}"));
        n += 1;
    }
    if src.is_dir() {
        copy_dir_all(&src, &dest).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }
    let rel = dest.strip_prefix(&canon_root).unwrap_or(&dest);
    Ok(rel.to_string_lossy().into_owned())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_symlink() {
            // Re-create the link rather than copying its (possibly outside-root)
            // target's contents into the tracked tree.
            let target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)?;
            #[cfg(windows)]
            {
                if from.is_dir() {
                    std::os::windows::fs::symlink_dir(&target, &to)?;
                } else {
                    std::os::windows::fs::symlink_file(&target, &to)?;
                }
            }
        } else if ft.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn base_file(state: State<AppState>, monitor_id: i64, snapshot_id: i64, path: String) -> R<Option<String>> {
    Ok(err(state.engine.base_file(monitor_id, snapshot_id, &path))?
        .map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
pub fn snapshot_summaries(state: State<AppState>, monitor_id: i64) -> R<Vec<ChangeSummary>> {
    err(state.engine.snapshot_change_summaries(monitor_id))
}

#[tauri::command]
pub fn snapshot_summaries_under(
    state: State<AppState>,
    monitor_id: i64,
    prefix: String,
) -> R<Vec<ChangeSummary>> {
    err(state.engine.snapshot_change_summaries_under(monitor_id, &prefix))
}

#[tauri::command]
pub fn git_reset_file(state: State<AppState>, monitor_id: i64, path: String) -> R<()> {
    err(state.engine.git_reset_file(monitor_id, &path))
}

#[tauri::command]
pub fn git_reset_folder(state: State<AppState>, monitor_id: i64, prefix: String, remove_extraneous: bool) -> R<()> {
    err(state.engine.git_reset_folder(monitor_id, &prefix, remove_extraneous))
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

/// Read any absolute file as text (for cross-file go-to-definition into Go
/// stdlib / module-cache packages, which live outside the workspace root).
/// Returns None for non-UTF8 (binary) content.
#[tauri::command]
pub fn read_text_file(path: String) -> R<Option<String>> {
    match std::fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(e) => Err(e.to_string()),
    }
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
pub fn git_checkout_branch(repo_path: String, branch: String) -> R<()> {
    err(git::checkout_branch(&PathBuf::from(repo_path), &branch))
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
pub fn git_discard_file(repo_path: String, path: String) -> R<()> {
    err(git::discard_file(&PathBuf::from(repo_path), &path))
}

#[tauri::command]
pub fn git_status(repo_path: String) -> R<WorkingStatus> {
    err(git::working_status(&PathBuf::from(repo_path)))
}

#[tauri::command]
pub fn git_stage(repo_path: String, paths: Vec<String>) -> R<()> {
    err(git::stage_paths(&PathBuf::from(repo_path), &paths))
}

#[tauri::command]
pub fn git_unstage(repo_path: String, paths: Vec<String>) -> R<()> {
    err(git::unstage_paths(&PathBuf::from(repo_path), &paths))
}

#[tauri::command]
pub fn git_commit(repo_path: String, message: String) -> R<String> {
    err(git::commit(&PathBuf::from(repo_path), &message))
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
pub fn git_merge_state(repo_path: String) -> R<git::MergeState> {
    err(git::merge_state(&PathBuf::from(repo_path)))
}

#[tauri::command]
pub fn git_merge_blocks(repo_path: String, path: String) -> R<Vec<ffcore::merge::MergeBlock>> {
    err(git::merge_blocks(&PathBuf::from(repo_path), &path))
}

#[tauri::command]
pub fn git_accept_side(repo_path: String, path: String, side: String) -> R<()> {
    err(git::accept_side(&PathBuf::from(repo_path), &path, &side))
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

#[tauri::command]
pub fn terminal_open(
    app: tauri::AppHandle,
    term: State<TerminalManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> R<u64> {
    term.open(&app, cwd, cols, rows)
}

#[tauri::command]
pub fn terminal_write(term: State<TerminalManager>, id: u64, data: String) -> R<()> {
    term.write(id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(term: State<TerminalManager>, id: u64, cols: u16, rows: u16) -> R<()> {
    term.resize(id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(term: State<TerminalManager>, id: u64) {
    term.close(id);
}

#[tauri::command]
pub fn lsp_start(app: tauri::AppHandle, lsp: State<LspManager>, root: String) -> R<()> {
    lsp.start(&app, root)
}

#[tauri::command]
pub fn lsp_send(lsp: State<LspManager>, root: String, body: String) -> R<()> {
    lsp.send(&root, &body)
}

#[tauri::command]
pub fn lsp_stop(lsp: State<LspManager>, root: String) {
    lsp.stop(&root);
}

// Async + spawn_blocking: start blocks until dlv prints its listen address; a
// sync command would hold the main thread and freeze the UI for that long.
#[tauri::command]
pub async fn dap_start(app: tauri::AppHandle, root: String) -> R<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        let dap = app.state::<DapManager>();
        dap.start(&app, root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn dap_send(dap: State<DapManager>, id: u64, body: String) -> R<()> {
    dap.send(id, &body)
}

#[tauri::command]
pub fn dap_stop(dap: State<DapManager>, id: u64) {
    dap.stop(id);
}

#[tauri::command]
pub fn run_start(
    app: tauri::AppHandle,
    run: State<RunManager>,
    cwd: String,
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
) -> R<u64> {
    run.start(&app, cwd, program, args, env)
}

#[tauri::command]
pub fn run_stop(run: State<RunManager>, id: u64) {
    run.stop(id);
}

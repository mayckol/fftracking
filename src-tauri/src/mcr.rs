// Launches the external MCR app (https://github.com/mayckol/mcr) for git merge
// and compare, replacing the old in-app Monaco merge/diff editors. Merge follows
// git's mergetool contract: MCR reads LOCAL/BASE/REMOTE, writes MERGED, and exits
// 0 on Save & Exit — staging is on us afterwards.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

const INSTALL_HINT: &str =
    "MCR is not installed (or not on this app's PATH). Install it: https://github.com/mayckol/mcr";

static TMP_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct McrState {
    // repo\0path merges currently open in MCR, so a fast double-click coalesces
    // instead of spawning two editors on the same file (the old mergeWindow.ts
    // inFlight set, made authoritative in Rust).
    in_flight: Arc<Mutex<HashSet<String>>>,
}

/// fftracking itself runs as an AppImage on Linux, so its process carries the
/// AppImage runtime's injected vars (APPDIR/APPIMAGE/ARGV0 markers plus prepended
/// LD_LIBRARY_PATH and GTK/GDK/GST plugin paths pointing into fftracking's own
/// /tmp/.mount_*). A child AppImage inherits them: MCR's AppRun then mis-detects
/// an already-mounted image and loads fftracking's libs instead of its own, so it
/// dies before showing a window — invisible to us, which is why MCR launches from
/// a terminal but never from inside the app. Drop them so MCR bootstraps clean.
#[cfg(target_os = "linux")]
fn strip_appimage_env(cmd: &mut Command) {
    const VARS: &[&str] = &[
        "APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD",
        "PYTHONPATH", "PYTHONHOME", "PERLLIB", "GSETTINGS_SCHEMA_DIR",
        "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR", "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH",
        "QT_PLUGIN_PATH",
    ];
    for v in VARS {
        cmd.env_remove(v);
    }
}

fn is_exec(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// PATH first, then the installer's known locations — a packaged GUI app
/// inherits a stripped PATH (same problem run.rs solves for go/node tools).
fn find_mcr() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);

    // On Linux the `mcr` on PATH (and ~/.local/bin/mcr) is a launcher SHELL WRAPPER
    // that reinterprets argv for `mcr [dir]`/`mcr diff` — it drops the extra files
    // of our 4-way merge signature and chdir's the AppImage into its own mount,
    // losing our cwd anchor. Invoke the raw AppImage directly instead, exactly as
    // macOS invokes the raw .app binary (a transparent `exec … "$@"` passthrough).
    #[cfg(target_os = "linux")]
    if let Some(h) = &home {
        let c = h.join(".local/bin/mcr.AppImage");
        if is_exec(&c) {
            return Ok(c);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let c = dir.join("mcr");
            if is_exec(&c) {
                return Ok(c);
            }
        }
    }
    if let Some(h) = &home {
        let c = h.join(".local/bin/mcr");
        if is_exec(&c) {
            return Ok(c);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let c = PathBuf::from("/Applications/MCR.app/Contents/MacOS/mcr-app");
        if is_exec(&c) {
            return Ok(c);
        }
    }
    Err(INSTALL_HINT.into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeArgs {
    pub repo_path: String,
    pub path: String,
}

#[tauri::command]
pub fn mcr_open_merge(
    app: tauri::AppHandle,
    state: tauri::State<McrState>,
    args: MergeArgs,
) -> Result<(), String> {
    let bin = find_mcr()?;
    let key = format!("{}\0{}", args.repo_path, args.path);
    if !state.in_flight.lock().unwrap().insert(key.clone()) {
        return Ok(());
    }
    let guard = state.in_flight.clone();
    spawn_merge(app, bin, args, key.clone(), guard.clone()).inspect_err(|_| {
        guard.lock().unwrap().remove(&key);
    })
}

fn spawn_merge(
    app: tauri::AppHandle,
    bin: PathBuf,
    args: MergeArgs,
    key: String,
    guard: Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    let e2s = |e: &dyn std::fmt::Display| e.to_string();
    let sides = ffcore::git::conflict_sides(Path::new(&args.repo_path), &args.path)
        .map_err(|e| e.to_string())?;

    // Keep the real filename so MCR's language detection works:
    // <tmp>/fftracking-mcr-<pid>-<n>/{LOCAL,BASE,REMOTE}/<basename>.
    let dir = std::env::temp_dir().join(format!(
        "fftracking-mcr-{}-{}",
        std::process::id(),
        TMP_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let name = Path::new(&args.path)
        .file_name()
        .ok_or_else(|| format!("invalid conflict path: {}", args.path))?
        .to_owned();
    let side_file = |label: &str, content: &Option<String>| -> Result<PathBuf, String> {
        let d = dir.join(label);
        std::fs::create_dir_all(&d).map_err(|e| e2s(&e))?;
        let f = d.join(&name);
        // A missing stage (add/add, add/delete) becomes an empty pane.
        std::fs::write(&f, content.as_deref().unwrap_or("")).map_err(|e| e2s(&e))?;
        Ok(f)
    };
    let local = side_file("LOCAL", &sides.ours)?;
    let base = side_file("BASE", &sides.base)?;
    let remote = side_file("REMOTE", &sides.theirs)?;

    // MERGED is the real working file — MCR resolves the repo root from it and
    // writes the result there on save. A modify/delete conflict can leave it
    // absent, so seed it to give MCR a target.
    let merged = Path::new(&args.repo_path).join(&args.path);
    if !merged.exists() {
        if let Some(p) = merged.parent() {
            std::fs::create_dir_all(p).map_err(|e| e2s(&e))?;
        }
        let seed = sides.ours.as_deref().or(sides.theirs.as_deref()).unwrap_or("");
        std::fs::write(&merged, seed).map_err(|e| e2s(&e))?;
    }

    let mut cmd = Command::new(&bin);
    cmd.args([local.as_os_str(), base.as_os_str(), remote.as_os_str(), merged.as_os_str()]);
    #[cfg(target_os = "linux")]
    strip_appimage_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't launch MCR: {e}"))?;

    let (repo, path) = (args.repo_path, args.path);
    std::thread::spawn(move || {
        let saved = child.wait().map(|s| s.success()).unwrap_or(false);
        if saved {
            match ffcore::git::stage_paths(Path::new(&repo), &[path.clone()]) {
                Ok(()) => {
                    let _ = app.emit("merge-resolved", serde_json::json!({ "path": path }));
                }
                Err(e) => {
                    let _ = app.emit("mcr-error", format!("MCR saved {path} but staging it failed: {e}"));
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        guard.lock().unwrap().remove(&key);
    });
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffArgs {
    pub repo_path: String,
    pub git_ref: String,
}

#[tauri::command]
pub fn mcr_open_diff(args: DiffArgs) -> Result<(), String> {
    let bin = find_mcr()?;
    // macOS anchors off the cwd (the raw .app keeps it). The Linux AppImage
    // chdir's into its own /tmp/.mount_* at startup, destroying the cwd, so pass
    // the repo as the explicit `[dir]` anchor — MCR resolves it correctly now that
    // upstream compensates for repo_root()'s parent() (lib.rs joins "." first).
    let mut cmd = Command::new(&bin);
    cmd.arg("diff").arg(&args.git_ref).current_dir(&args.repo_path);
    #[cfg(target_os = "linux")]
    {
        cmd.arg(&args.repo_path);
        strip_appimage_env(&mut cmd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't launch MCR: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

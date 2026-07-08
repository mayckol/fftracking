// Launches the external MCR app (https://github.com/mayckol/mcr) for git merge
// and compare, replacing the old in-app Monaco merge/diff editors. Merge follows
// git's mergetool contract: MCR reads LOCAL/BASE/REMOTE, writes MERGED, and exits
// 0 on Save & Exit — staging is on us afterwards.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
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
/// LD_LIBRARY_PATH, GTK/GDK/GIO/GST module paths, and PATH/XDG_DATA_DIRS entries
/// pointing into fftracking's own /tmp/.mount_*). A child AppImage inherits them:
/// MCR then resolves libraries, GIO modules, or even its AppDir out of
/// fftracking's mount instead of its own and dies before showing a window —
/// invisible to us, which is why MCR launches from a terminal but never from
/// inside the app. Drop the poisoned vars and filter the path-lists clean.
#[cfg(target_os = "linux")]
fn strip_appimage_env(cmd: &mut Command) {
    const VARS: &[&str] = &[
        "APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD",
        "PYTHONPATH", "PYTHONHOME", "PERLLIB", "GSETTINGS_SCHEMA_DIR",
        "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR",
        "GIO_MODULE_DIR", "GIO_EXTRA_MODULES",
        "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GST_REGISTRY", "GST_REGISTRY_1_0", "QT_PLUGIN_PATH",
        "WEBKIT_EXEC_PATH", "WEBKIT_INJECTED_BUNDLE_PATH",
    ];
    for v in VARS {
        cmd.env_remove(v);
    }
    // PATH and XDG_DATA_DIRS are prepended (not replaced) by the AppImage runtime;
    // removing them outright would break tool lookup and desktop integration, so
    // drop only the entries that point into an AppImage mount.
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let in_mount = |p: &Path| {
        appdir.as_deref().is_some_and(|a| p.starts_with(a))
            || p.to_string_lossy().starts_with("/tmp/.mount_")
    };
    for key in ["PATH", "XDG_DATA_DIRS"] {
        if let Some(v) = std::env::var_os(key) {
            let kept: Vec<PathBuf> =
                std::env::split_paths(&v).filter(|p| !in_mount(p)).collect();
            match std::env::join_paths(kept) {
                Ok(clean) if !clean.is_empty() => {
                    cmd.env(key, clean);
                }
                _ => {
                    cmd.env_remove(key);
                }
            }
        }
    }
}

/// Whether the classic AppImage runtime can mount at all. Without libfuse2 a raw
/// .AppImage exec dies instantly (the installer's wrappers set
/// APPIMAGE_EXTRACT_AND_RUN=1 for this, but we spawn the image directly).
#[cfg(target_os = "linux")]
fn has_libfuse2() -> bool {
    static FUSE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FUSE.get_or_init(|| {
        Command::new("sh")
            .args(["-c", "ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2'"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// A Command for the MCR binary with a launch environment the child can actually
/// boot in, and stderr captured so an early death is diagnosable instead of
/// silent.
fn mcr_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    {
        strip_appimage_env(&mut cmd);
        if bin.extension().is_some_and(|e| e == "AppImage") && !has_libfuse2() {
            cmd.env("APPIMAGE_EXTRACT_AND_RUN", "1");
        }
    }
    cmd
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

/// Installer locations first, then PATH — a packaged GUI app inherits a stripped
/// PATH (same problem run.rs solves for go/node tools).
fn find_mcr() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);

    #[cfg(target_os = "linux")]
    if let Some(h) = &home {
        // Fastest and most robust: the installer's pre-extracted AppDir — no
        // libfuse2 requirement, no per-launch mount or self-extraction.
        let c = h.join(".local/libexec/mcr/squashfs-root/AppRun");
        if is_exec(&c) {
            return Ok(c);
        }
        // Raw AppImage next. The `mcr` on PATH (and ~/.local/bin/mcr) is a
        // launcher SHELL WRAPPER that reinterprets argv for `mcr [dir]`/`mcr
        // diff` — it drops the extra files of our 4-way merge signature — so the
        // image itself is invoked, with the FUSE fallback mcr_command applies.
        let c = h.join(".local/bin/mcr.AppImage");
        if is_exec(&c) {
            return Ok(c);
        }
    }
    #[cfg(target_os = "macos")]
    for base in ["/Applications", "/System/Volumes/Data/Applications"] {
        let c = Path::new(base).join("MCR.app/Contents/MacOS/mcr-app");
        if is_exec(&c) {
            return Ok(c);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(h) = &home {
        let c = h.join("Applications/MCR.app/Contents/MacOS/mcr-app");
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
    Err(INSTALL_HINT.into())
}

/// Wait for MCR, keeping the tail of its stderr. A GUI child that dies before
/// showing a window is otherwise indistinguishable from "nothing happened".
fn wait_with_stderr(child: &mut Child) -> (bool, i32, String) {
    let stderr = child.stderr.take();
    let tail = stderr
        .map(|mut s| {
            let mut buf = String::new();
            let _ = s.by_ref().take(16 * 1024).read_to_string(&mut buf);
            // Drain whatever remains so a chatty child never blocks on the pipe.
            let _ = std::io::copy(&mut s, &mut std::io::sink());
            buf
        })
        .unwrap_or_default();
    let status = child.wait();
    let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
    (success, code, tail.trim().to_string())
}

/// A non-zero exit is only user-facing news when MCR died during startup — the
/// class of failure that used to look like "nothing happened" (FUSE missing,
/// poisoned env, webview init crash). A plain abort (closing the window on an
/// unresolved file) exits 1 after human-scale seconds — and may carry harmless
/// GTK/WebKit warnings on stderr — so anything past the startup window stays
/// quiet.
fn report_death(app: &tauri::AppHandle, code: i32, stderr: &str, started: Instant) {
    let secs = started.elapsed().as_secs();
    if secs >= 10 {
        return;
    }
    let detail = if !stderr.is_empty() {
        format!("MCR failed (status {code}): {stderr}")
    } else if secs < 3 {
        format!("MCR exited immediately (status {code}) without output")
    } else {
        return;
    };
    let _ = app.emit("mcr-error", detail);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeArgs {
    pub repo_path: String,
    pub path: String,
}

#[tauri::command(async)]
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

    let mut cmd = mcr_command(&bin);
    cmd.args([local.as_os_str(), base.as_os_str(), remote.as_os_str(), merged.as_os_str()]);
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("couldn't launch MCR: {e}"))?;

    let (repo, path) = (args.repo_path, args.path);
    std::thread::spawn(move || {
        let (saved, code, stderr) = wait_with_stderr(&mut child);
        if saved {
            match ffcore::git::stage_paths(Path::new(&repo), &[path.clone()]) {
                Ok(()) => {
                    let _ = app.emit("merge-resolved", serde_json::json!({ "path": path }));
                }
                Err(e) => {
                    let _ = app.emit("mcr-error", format!("MCR saved {path} but staging it failed: {e}"));
                }
            }
        } else {
            report_death(&app, code, &stderr, started);
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

// The Git tab embeds per-file diffs as a child webview (mcr_embed.rs). This
// whole-repo launch stays for the History panel's "open in MCR" compare, which
// wants MCR's own file sidebar across the entire repo against a ref.
#[tauri::command(async)]
pub fn mcr_open_diff(app: tauri::AppHandle, args: DiffArgs) -> Result<(), String> {
    let bin = find_mcr()?;
    // macOS anchors off the cwd (the raw .app keeps it). On Linux the launch may
    // go through the AppImage (which destroys the cwd by chdir'ing into its
    // mount), so also pass the repo as the explicit `[dir]` anchor — upstream
    // compensates for repo_root()'s parent() (lib.rs joins "." first).
    let mut cmd = mcr_command(&bin);
    cmd.arg("diff").arg(&args.git_ref).current_dir(&args.repo_path);
    #[cfg(target_os = "linux")]
    cmd.arg(&args.repo_path);
    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't launch MCR: {e}"))?;
    std::thread::spawn(move || {
        let (ok, code, stderr) = wait_with_stderr(&mut child);
        if !ok {
            report_death(&app, code, &stderr, started);
        }
    });
    Ok(())
}

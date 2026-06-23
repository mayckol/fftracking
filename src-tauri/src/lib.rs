mod commands;
mod dap;
mod lsp;
mod run;
mod terminal;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ffcore::detect::detect_workspaces;
use ffcore::runner::MonitorManager;
use ffcore::sysmon::SelfMonitor;
use ffcore::Engine;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

pub struct AppState {
    pub engine: Arc<Engine>,
    pub manager: Arc<MonitorManager>,
    pub sysmon: Mutex<SelfMonitor>,
    // A project id queued by the CLI launcher (`fftrack <path>`) on cold start,
    // claimed once by the UI on mount so it opens that project.
    pub pending_open: Mutex<Option<i64>>,
}

const DETECT_INTERVAL: Duration = Duration::from_secs(5);

// Resolves the first non-flag CLI argument to an absolute directory, relative to
// `cwd`. A file path resolves to its parent (the app is project/folder-based).
fn project_arg(argv: &[String], cwd: &str) -> Option<PathBuf> {
    let raw = argv.iter().skip(1).find(|a| !a.starts_with('-'))?;
    let p = PathBuf::from(raw);
    let abs = if p.is_absolute() { p } else { PathBuf::from(cwd).join(p) };
    let abs = abs.canonicalize().unwrap_or(abs);
    if abs.is_dir() {
        Some(abs)
    } else {
        abs.parent().map(|x| x.to_path_buf())
    }
}

// Opens the project named on the command line: adds/activates its monitor,
// surfaces the window, and tells the UI to select it (via a queued id read on
// mount plus an "open-project" event for an already-running instance).
fn open_project_from_argv(app: &tauri::AppHandle, argv: &[String], cwd: &str) {
    let Some(root) = project_arg(argv, cwd) else { return };
    let state = app.state::<AppState>();
    let interval = state.engine.get_settings().map(|s| s.default_interval_secs).unwrap_or(900);
    match commands::activate_monitor(&state, &root, interval) {
        Ok(id) => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Ok(mut g) = state.pending_open.lock() {
                *g = Some(id);
            }
            let _ = app.emit("open-project", id);
        }
        Err(e) => eprintln!("fftrack: could not open {}: {e}", root.display()),
    }
}

pub fn run() {
    tauri::Builder::default()
        // First plugin: a second `fftrack <path>` invocation forwards its argv
        // here instead of spawning a rival instance on the same database.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_project_from_argv(app, &argv, &cwd);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("ff".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            if let Ok(dir) = app.path().app_log_dir() {
                println!("📂 ff logs: {}/ff.log  (tail -f to follow)", dir.display());
            }
            let data_dir = app.path().app_data_dir()?;
            let engine = Engine::open(&data_dir)?;
            let manager = Arc::new(MonitorManager::new(engine.clone()));

            // Push a "monitor-changed" event on every filesystem change so the
            // UI refreshes the tree / open file (covers touch, branch switch,
            // external edits) without polling the working tree.
            let change_handle = app.handle().clone();
            manager.set_change_listener(move |monitor_id| {
                let _ = change_handle.emit("monitor-changed", monitor_id);
            });

            // "tree-changed" is the poll-driven counterpart: it fires when the
            // working tree drifts from disk regardless of the OS watcher, so
            // files/folders an external terminal or AI agent adds, removes, or
            // edits still refresh the project tree. Breaking-point capture is
            // untouched — this only nudges the UI to re-list.
            let tree_handle = app.handle().clone();
            manager.set_tree_change_listener(move |monitor_id| {
                let _ = tree_handle.emit("tree-changed", monitor_id);
            });

            // Exclusive monitoring: resume at most one active monitor. Older
            // databases may carry several active rows; keep the first and clear
            // the rest so capture stays single-project even before the window
            // opens. The UI re-selects the last project on launch.
            let mut resumed = false;
            for m in engine.list_monitors()? {
                if !m.active {
                    continue;
                }
                if !resumed {
                    let _ = manager.start(m.id, &PathBuf::from(&m.root_path), m.interval_secs);
                    resumed = true;
                } else {
                    let _ = engine.deactivate_monitor(m.id);
                }
            }

            app.manage(AppState {
                engine: engine.clone(),
                manager: manager.clone(),
                sysmon: Mutex::new(SelfMonitor::new()),
                pending_open: Mutex::new(None),
            });
            app.manage(terminal::TerminalManager::default());
            app.manage(lsp::LspManager::default());
            app.manage(dap::DapManager::default());
            app.manage(run::RunManager::default());
            #[cfg(target_os = "macos")]
            setup_app_menu(app.handle())?;
            setup_tray(app.handle())?;
            spawn_detect_daemon(engine);

            // Cold-start CLI launch: `fftracking <path>` opens that project. The
            // id is queued in pending_open; the UI claims it on mount. Prefer the
            // AppImage's $OWD (the directory the user launched from) over
            // current_dir, which is the /tmp/.mount_* mount on Linux.
            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::var("OWD")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_default();
            open_project_from_argv(app.handle(), &argv, &cwd);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_monitor,
            commands::take_pending_open,
            commands::install_cli,
            commands::install_method,
            commands::run_update,
            commands::quit_app,
            commands::list_monitors,
            commands::start_monitor,
            commands::stop_monitor,
            commands::set_active_monitor,
            commands::remove_monitor,
            commands::snapshot_now,
            commands::delete_snapshot,
            commands::set_snapshot_label,
            commands::list_snapshots,
            commands::previous_snapshot,
            commands::changed_files,
            commands::monitor_base_info,
            commands::breaking_point_changes,
            commands::snapshot_working_changes,
            commands::monitor_files,
            commands::search_content,
            commands::replace_match,
            commands::replace_all,
            commands::open_path,
            commands::reveal_path,
            commands::delete_path,
            commands::create_file,
            commands::create_dir,
            commands::rename_path,
            commands::duplicate_path,
            commands::base_file,
            commands::snapshot_summaries,
            commands::snapshot_summaries_under,
            commands::git_reset_file,
            commands::git_reset_folder,
            commands::snapshot_files,
            commands::file_at,
            commands::working_file,
            commands::write_working_file,
            commands::read_text_file,
            commands::file_hunks,
            commands::text_hunks,
            commands::apply_text_revert,
            commands::revert_file,
            commands::revert_folder,
            commands::revert_hunks,
            commands::get_settings,
            commands::set_setting,
            commands::detected_workspaces,
            commands::git_list_refs,
            commands::git_changed_files,
            commands::git_checkout_branch,
            commands::git_file,
            commands::git_file_hunks,
            commands::git_revert_hunks,
            commands::git_apply_hunk,
            commands::git_write_working,
            commands::git_discard_file,
            commands::git_status,
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
            commands::git_conflicts,
            commands::git_resolve_conflict,
            commands::git_merge_state,
            commands::git_merge_blocks,
            commands::git_accept_side,
            commands::pick_folder,
            commands::set_autostart,
            commands::autostart_enabled,
            commands::resource_usage,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::lsp_start,
            commands::lsp_send,
            commands::lsp_stop,
            commands::dap_start,
            commands::dap_send,
            commands::dap_stop,
            commands::run_start,
            commands::run_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error building fftracking")
        .run(|app, event| {
            // Keep the daemon alive in the tray when the window is closed.
            if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = event {
                if label == "main" {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
        });
}

/// Replaces the default macOS menu: keeps the Edit items the webview needs for
/// ⌘C/⌘V/⌘Z to work, but drops "Close Window" so ⌘W is free for editor
/// shortcuts (delete word) instead of hiding the app.
#[cfg(target_os = "macos")]
fn setup_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{PredefinedMenuItem, Submenu};

    let app_menu = Submenu::with_items(
        app,
        "fftracking",
        true,
        &[
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &window])?)?;
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open fftracking", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("fftracking")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Polls for running editors and registers their workspaces as monitors so they
/// surface in the project picker. Discovery only: nothing is captured until the
/// user selects a project (exclusive monitoring), so the daemon never starts or
/// stops capture itself.
fn spawn_detect_daemon(engine: Arc<Engine>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(DETECT_INTERVAL);
        let interval = engine.get_settings().map(|s| s.default_interval_secs).unwrap_or(900);
        for ws in detect_workspaces() {
            let root = PathBuf::from(&ws.path);
            if !root.is_dir() {
                continue;
            }
            let _ = engine.discover_monitor(&root, interval, &ws.source);
        }
    });
}

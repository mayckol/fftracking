mod commands;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ffcore::detect::detect_workspaces;
use ffcore::runner::MonitorManager;
use ffcore::sysmon::SelfMonitor;
use ffcore::Engine;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

pub struct AppState {
    pub engine: Arc<Engine>,
    pub manager: Arc<MonitorManager>,
    pub sysmon: Mutex<SelfMonitor>,
}

const DETECT_INTERVAL: Duration = Duration::from_secs(5);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let engine = Engine::open(&data_dir)?;
            let manager = Arc::new(MonitorManager::new(engine.clone()));

            // Resume watching monitors that were active in a previous session.
            for m in engine.list_monitors()? {
                if m.active {
                    let _ = manager.start(m.id, &PathBuf::from(&m.root_path), m.interval_secs);
                }
            }

            app.manage(AppState {
                engine: engine.clone(),
                manager: manager.clone(),
                sysmon: Mutex::new(SelfMonitor::new()),
            });
            setup_tray(app.handle())?;
            spawn_detect_daemon(engine, manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_monitor,
            commands::list_monitors,
            commands::start_monitor,
            commands::stop_monitor,
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
            commands::open_path,
            commands::reveal_path,
            commands::base_file,
            commands::snapshot_summaries,
            commands::git_reset_file,
            commands::git_reset_folder,
            commands::snapshot_files,
            commands::file_at,
            commands::working_file,
            commands::write_working_file,
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
            commands::git_file,
            commands::git_file_hunks,
            commands::git_revert_hunks,
            commands::git_write_working,
            commands::git_status,
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
            commands::git_conflicts,
            commands::git_resolve_conflict,
            commands::pick_folder,
            commands::set_autostart,
            commands::autostart_enabled,
            commands::resource_usage,
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

/// Polls for running editors and reconciles the set of editor-sourced monitors:
/// newly focused folders start watching, folders whose editor closed stop.
fn spawn_detect_daemon(engine: Arc<Engine>, manager: Arc<MonitorManager>) {
    std::thread::spawn(move || {
        let mut active: HashMap<String, i64> = HashMap::new();
        loop {
            std::thread::sleep(DETECT_INTERVAL);
            let interval = engine.get_settings().map(|s| s.default_interval_secs).unwrap_or(900);
            let detected = detect_workspaces();
            let seen: Vec<String> = detected.iter().map(|d| d.path.clone()).collect();

            for ws in detected {
                if active.contains_key(&ws.path) {
                    continue;
                }
                let root = PathBuf::from(&ws.path);
                if !root.is_dir() {
                    continue;
                }
                if let Ok(id) = engine.add_monitor(&root, interval, &ws.source) {
                    let _ = engine.snapshot_now(id, "manual");
                    let _ = manager.start(id, &root, interval);
                    active.insert(ws.path, id);
                }
            }

            let gone: Vec<String> = active.keys().filter(|p| !seen.contains(p)).cloned().collect();
            for path in gone {
                if let Some(id) = active.remove(&path) {
                    manager.stop(id);
                    let _ = engine.deactivate_monitor(id);
                }
            }
        }
    });
}

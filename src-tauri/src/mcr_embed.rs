// Embeds MCR's compare (diff) view as a child webview positioned over the Git
// tab's diff pane. The renderer and engine are reused verbatim from the `mcr-core`
// / `mcr-session` crates and the MCR UI bundle (built into `dist/mcr`); this module
// hosts the same Tauri command surface MCR's own app exposes — minus the merge-only
// commands — so the embedded UI's `invoke`s resolve, plus the child-webview
// lifecycle. Merge-conflict resolution still launches the standalone MCR app
// (see `mcr.rs`); only diffs embed.

use std::sync::Mutex;

use mcr_core::SessionModel;
use mcr_session::manager::{SessionManager, SessionProgress, SessionSummary};
use tauri::webview::WebviewBuilder;
use tauri::{Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Label of the child webview + the bundled MCR UI entry it loads.
const EMBED_LABEL: &str = "mcr-embed";
const EMBED_URL: &str = "mcr/index.html";
const MAIN_WINDOW: &str = "main";

/// Off-screen parking spot for the "hidden" embed on WebKitGTK (see `conceal`).
#[cfg(target_os = "linux")]
const PARK_OFF_SCREEN: f64 = -32000.0;

type Mgr<'a> = tauri::State<'a, SessionManager>;

/// The file the embedded view should currently show. Re-sent when the webview
/// announces readiness, since the first `mcr_embed_show` emit can land before the
/// freshly-created webview has registered its listener.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbedTarget {
    repo_root: String,
    refspec: String,
    path: String,
}

#[derive(Default)]
pub struct McrEmbed {
    target: Mutex<Option<EmbedTarget>>,
}

/// Register the readiness handshake: when the embedded webview finishes booting it
/// emits `mcr://embed-ready`; answer with the current target so a file selected
/// before the webview existed still renders.
pub fn setup(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen("mcr://embed-ready", move |_| {
        let target = handle.state::<McrEmbed>().target.lock().unwrap().clone();
        if let Some(t) = target {
            let _ = handle.emit_to(EMBED_LABEL, "mcr://embed-open", t);
        }
    });
}

// ── Child-webview lifecycle (called by fftracking's GitView) ───────────────────

/// Logical-pixel rect of the host pane, straight from `getBoundingClientRect()`
/// (Tauri logical units == CSS px, so no devicePixelRatio math).
#[derive(serde::Deserialize)]
pub struct EmbedBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedShowArgs {
    pub repo_root: String,
    pub refspec: String,
    pub path: String,
    pub bounds: EmbedBounds,
}

/// Show (creating on first use) the embedded diff for one file, sized to `bounds`,
/// and tell it which file to render.
#[tauri::command(async)]
pub fn mcr_embed_show(
    app: tauri::AppHandle,
    state: tauri::State<McrEmbed>,
    args: EmbedShowArgs,
) -> Result<(), String> {
    let target = EmbedTarget {
        repo_root: args.repo_root,
        refspec: args.refspec,
        path: args.path,
    };
    *state.target.lock().unwrap() = Some(target.clone());

    let webview = match app.get_webview(EMBED_LABEL) {
        Some(wv) => wv,
        None => {
            let window = app
                .get_window(MAIN_WINDOW)
                .ok_or_else(|| "main window not found".to_string())?;
            let builder = WebviewBuilder::new(EMBED_LABEL, WebviewUrl::App(EMBED_URL.into()))
                .initialization_script("window.__FF_EMBED__ = true;");
            window
                .add_child(
                    builder,
                    LogicalPosition::new(args.bounds.x, args.bounds.y),
                    LogicalSize::new(args.bounds.width, args.bounds.height),
                )
                .map_err(|e| e.to_string())?
        }
    };

    // Reveal, THEN position. On WebKitGTK the position handed to `add_child` (and
    // any `set_position` issued before the webview is on screen) is ignored until a
    // `set_position` lands *after* show() — the reverse order left it parked at the
    // window bottom for a frame, the "diff jumps up from the bottom" flash. An
    // existing webview is already shown here (Linux keeps it mapped and merely
    // parks it off-screen — see `conceal`), so this just slides it back over the
    // pane with no re-realize flash.
    webview.show().map_err(|e| e.to_string())?;
    place(&webview, &args.bounds)?;

    let _ = webview.emit_to(EMBED_LABEL, "mcr://embed-open", target);
    Ok(())
}

/// Hide the embed. On WebKitGTK, `hide()`/`show()` unmaps the child webview and
/// the next show() re-realizes it at a stale position (the window bottom) for a
/// frame before an explicit `set_position` lands — a visible jump on every
/// Git-tab entry. Keeping it mapped and parking it far off-screen instead makes
/// the next reveal a plain `set_position`, which lands reliably (the same call the
/// resize path already uses). Other platforms position child webviews correctly up
/// front, so a real `hide()` there is cheaper and leaves no mapped webview behind.
#[cfg(target_os = "linux")]
fn conceal(wv: &tauri::Webview) -> Result<(), String> {
    wv.set_position(LogicalPosition::new(PARK_OFF_SCREEN, PARK_OFF_SCREEN))
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn conceal(wv: &tauri::Webview) -> Result<(), String> {
    wv.hide().map_err(|e| e.to_string())
}

/// Apply a pane rect to the webview, in logical (CSS) pixels. On a debug build,
/// log the requested rect against the resulting physical geometry so a
/// platform coordinate/scale mismatch is diagnosable from the terminal.
fn place(webview: &tauri::Webview, b: &EmbedBounds) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(b.x, b.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(b.width, b.height))
        .map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    if let (Ok(p), Ok(s)) = (webview.position(), webview.size()) {
        eprintln!(
            "[mcr-embed] req logical x={} y={} w={} h={} -> physical pos={:?} size={:?}",
            b.x, b.y, b.width, b.height, p, s
        );
    }
    Ok(())
}

/// Reposition/resize the embedded webview as the host pane moves (window resize,
/// splitter drag, layout change).
#[tauri::command(async)]
pub fn mcr_embed_set_bounds(app: tauri::AppHandle, args: EmbedBounds) -> Result<(), String> {
    if let Some(wv) = app.get_webview(EMBED_LABEL) {
        place(&wv, &args)?;
    }
    Ok(())
}

/// Hide the embedded webview (leaving the Git tab, no file selected, or a host
/// overlay is open — a native webview paints above the DOM, so it must yield).
#[tauri::command(async)]
pub fn mcr_embed_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(EMBED_LABEL) {
        conceal(&wv)?;
    }
    Ok(())
}

// ── Session command surface (called by the embedded MCR UI) ────────────────────
// Thin wrappers over `SessionManager`, mirroring MCR's own `commands.rs`. The
// embedded UI invokes these by the same bare names, so the signatures must match.

#[tauri::command(async)]
pub fn compare_open(
    mgr: Mgr,
    root: String,
    refspec: String,
    path: String,
) -> Result<SessionModel, String> {
    mgr.open_compare_single(&root, &refspec, &path)
}

#[tauri::command(async)]
pub fn select_session(mgr: Mgr, session_id: String) -> Result<SessionModel, String> {
    mgr.model(&session_id)
}

#[tauri::command(async)]
pub fn list_sessions(mgr: Mgr) -> (Vec<SessionSummary>, SessionProgress) {
    (mgr.summaries(), mgr.progress())
}

#[tauri::command(async)]
pub fn save_merged(mgr: Mgr, session_id: String) -> Result<(), String> {
    mgr.save_merged(&session_id)
}

#[tauri::command(async)]
pub fn apply_change(
    mgr: Mgr,
    session_id: String,
    hunk_id: usize,
    from: String,
) -> Result<SessionModel, String> {
    mgr.apply_change(&session_id, hunk_id, &from)
}

#[tauri::command(async)]
pub fn apply_both(
    mgr: Mgr,
    session_id: String,
    hunk_id: usize,
    first: String,
) -> Result<SessionModel, String> {
    mgr.apply_both(&session_id, hunk_id, &first)
}

#[tauri::command(async)]
pub fn revert_change(mgr: Mgr, session_id: String, hunk_id: usize) -> Result<SessionModel, String> {
    mgr.revert_change(&session_id, hunk_id)
}

#[tauri::command(async)]
pub fn apply_non_conflicting(mgr: Mgr, session_id: String, from: String) -> Result<SessionModel, String> {
    mgr.apply_non_conflicting(&session_id, &from)
}

#[tauri::command(async)]
pub fn edit_result(
    mgr: Mgr,
    session_id: String,
    start: usize,
    end: usize,
    text: String,
) -> Result<SessionModel, String> {
    mgr.edit_result(&session_id, start, end, &text)
}

#[tauri::command(async)]
pub fn edit_full_result(mgr: Mgr, session_id: String, text: String) -> Result<SessionModel, String> {
    mgr.set_full_result(&session_id, &text)
}

#[tauri::command(async)]
pub fn undo(mgr: Mgr, session_id: String) -> Result<SessionModel, String> {
    mgr.undo(&session_id)
}

#[tauri::command(async)]
pub fn redo(mgr: Mgr, session_id: String) -> Result<SessionModel, String> {
    mgr.redo(&session_id)
}

#[tauri::command(async)]
pub fn navigate(
    mgr: Mgr,
    session_id: String,
    direction: String,
    from_hunk: Option<usize>,
) -> Result<Option<usize>, String> {
    mgr.navigate(&session_id, &direction, from_hunk)
}

#[tauri::command(async)]
pub fn set_whitespace_mode(mgr: Mgr, session_id: String, mode: String) -> Result<SessionModel, String> {
    mgr.set_whitespace_mode(&session_id, &mode)
}

/// The embedded compare view never closes a process — Close is hidden and Save
/// writes the worktree — but the shared MCR UI keeps `quit` in its client, so
/// answer it as a no-op rather than let the invoke fail.
#[tauri::command]
pub fn quit(_code: i32) {}

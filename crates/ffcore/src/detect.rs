use std::path::PathBuf;

use serde::Serialize;
use sysinfo::System;

use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetectedWorkspace {
    pub path: String,
    pub source: String, // "vscode" | "zed"
}

/// Best-effort detection of the folder currently focused in a running editor.
/// Reads each editor's own state file (rather than window-manager focus APIs),
/// which needs no special OS permissions and works the same on macOS + Linux.
pub fn detect_workspaces() -> Vec<DetectedWorkspace> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let running = |needle: &str| {
        sys.processes()
            .values()
            .any(|p| p.name().to_string_lossy().eq_ignore_ascii_case(needle))
    };

    let mut out = Vec::new();
    if running("Code") || running("code") {
        if let Some(path) = vscode_workspace() {
            out.push(DetectedWorkspace { path, source: "vscode".into() });
        }
    }
    if running("Zed") || running("zed") {
        if let Some(path) = zed_workspace() {
            out.push(DetectedWorkspace { path, source: "zed".into() });
        }
    }
    out
}

fn vscode_workspace() -> Option<String> {
    let json = std::fs::read_to_string(vscode_storage_path()?).ok()?;
    parse_vscode_storage(&json)
}

#[cfg(target_os = "macos")]
fn vscode_storage_path() -> Option<PathBuf> {
    Some(
        dirs_home()?
            .join("Library/Application Support/Code/User/globalStorage/storage.json"),
    )
}

#[cfg(not(target_os = "macos"))]
fn vscode_storage_path() -> Option<PathBuf> {
    Some(dirs_home()?.join(".config/Code/User/globalStorage/storage.json"))
}

/// Extracts the focused folder from VSCode's `storage.json`
/// (`windowsState.lastActiveWindow.folder`, a `file://` URI).
pub fn parse_vscode_storage(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let folder = v
        .get("windowsState")?
        .get("lastActiveWindow")?
        .get("folder")?
        .as_str()?;
    Some(uri_to_path(folder))
}

fn uri_to_path(uri: &str) -> String {
    let raw = uri.strip_prefix("file://").unwrap_or(uri);
    percent_decode(raw)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "macos")]
fn zed_db_dir() -> Option<PathBuf> {
    Some(dirs_home()?.join("Library/Application Support/Zed/db"))
}

#[cfg(not(target_os = "macos"))]
fn zed_db_dir() -> Option<PathBuf> {
    Some(dirs_home()?.join(".local/share/zed/db"))
}

/// Reads Zed's most-recently-active workspace from its SQLite store. Zed's
/// schema shifts between versions, so this scans the latest row's text for the
/// first path that still exists rather than relying on a fixed column shape.
fn zed_workspace() -> Option<String> {
    let dir = zed_db_dir()?;
    let db = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.join("db.sqlite").exists())?
        .join("db.sqlite");
    read_zed_latest_path(&db).ok().flatten()
}

fn read_zed_latest_path(db_path: &std::path::Path) -> Result<Option<String>> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT local_paths FROM workspaces ORDER BY timestamp DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(raw.and_then(|bytes| first_existing_dir(&String::from_utf8_lossy(&bytes))))
}

/// Pulls path-looking, currently-existing directories out of an opaque blob.
fn first_existing_dir(text: &str) -> Option<String> {
    text.split(|c: char| c.is_control() || c == '\0' || c == ',')
        .map(str::trim)
        .filter(|s| s.starts_with('/'))
        .find(|s| std::path::Path::new(s).is_dir())
        .map(String::from)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vscode_focused_folder() {
        let json = r#"{
            "windowsState": {
                "lastActiveWindow": { "folder": "file:///Users/me/My%20Proj" },
                "openedWindows": []
            }
        }"#;
        assert_eq!(parse_vscode_storage(json).as_deref(), Some("/Users/me/My Proj"));
    }

    #[test]
    fn missing_folder_yields_none() {
        assert!(parse_vscode_storage(r#"{"windowsState":{}}"#).is_none());
    }
}

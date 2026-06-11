// Generic LSP-over-stdio bridge. One language server (gopls) per workspace
// root; the frontend builds JSON-RPC messages, this layer only frames them
// (`Content-Length` headers) and pumps stdout frames back as `lsp://message`
// events. Mirrors the child-process pattern in terminal.rs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Locate the gopls binary. Tauri apps inherit a stripped PATH, so probe the
/// usual Go install locations before falling back to a PATH search.
fn find_gopls() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(gp) = std::env::var("GOPATH") {
        cands.push(PathBuf::from(gp).join("bin").join("gopls"));
    }
    if let Ok(home) = std::env::var("HOME") {
        cands.push(PathBuf::from(&home).join("go").join("bin").join("gopls"));
    }
    cands.push(PathBuf::from("/opt/homebrew/bin/gopls"));
    cands.push(PathBuf::from("/usr/local/bin/gopls"));
    for c in cands {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("gopls");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

struct Server {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<String, Server>>,
}

#[derive(Clone, Serialize)]
struct Msg {
    root: String,
    body: String,
}

fn write_frame(stdin: &mut ChildStdin, body: &str) -> Result<(), String> {
    write!(stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(e2s)?;
    stdin.flush().map_err(e2s)
}

impl LspManager {
    /// Start gopls for `root` if not already running. Idempotent.
    pub fn start(&self, app: &AppHandle, root: String) -> Result<(), String> {
        let mut servers = self.servers.lock().unwrap();
        if servers.contains_key(&root) {
            return Ok(());
        }
        let bin = find_gopls().ok_or_else(|| {
            "gopls not found. Install it with `go install golang.org/x/tools/gopls@latest`.".to_string()
        })?;

        let mut child = Command::new(bin)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(e2s)?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let app = app.clone();
        let r = root.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            let _ = app.emit("lsp://exit", &r);
                            return;
                        }
                        Ok(_) => {}
                    }
                    let t = line.trim_end();
                    if t.is_empty() {
                        break; // end of headers
                    }
                    if let Some(v) = t.strip_prefix("Content-Length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                if content_len == 0 {
                    continue;
                }
                let mut buf = vec![0u8; content_len];
                if reader.read_exact(&mut buf).is_err() {
                    let _ = app.emit("lsp://exit", &r);
                    return;
                }
                let body = String::from_utf8_lossy(&buf).to_string();
                let _ = app.emit("lsp://message", Msg { root: r.clone(), body });
            }
        });

        servers.insert(root, Server { stdin, child });
        Ok(())
    }

    /// Frame and forward a raw JSON-RPC message to the server for `root`.
    pub fn send(&self, root: &str, body: &str) -> Result<(), String> {
        let mut servers = self.servers.lock().unwrap();
        let s = servers.get_mut(root).ok_or("no server for root")?;
        write_frame(&mut s.stdin, body)
    }

    pub fn stop(&self, root: &str) {
        if let Some(mut s) = self.servers.lock().unwrap().remove(root) {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

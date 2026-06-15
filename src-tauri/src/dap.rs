// Debug Adapter Protocol bridge for Go (delve). One `dlv dap` process per
// session; dlv only accepts DAP over TCP, so we spawn it on an ephemeral port,
// parse the "listening at" line, and pump frames both ways — the frontend
// builds DAP JSON, this layer only does `Content-Length` framing. Mirrors the
// stdio pattern in lsp.rs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Locate the dlv binary. Tauri apps inherit a stripped PATH, so probe the
/// usual Go install locations before falling back to a PATH search.
fn find_dlv() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(gp) = std::env::var("GOPATH") {
        cands.push(PathBuf::from(gp).join("bin").join("dlv"));
    }
    if let Ok(home) = std::env::var("HOME") {
        cands.push(PathBuf::from(&home).join("go").join("bin").join("dlv"));
    }
    cands.push(PathBuf::from("/opt/homebrew/bin/dlv"));
    cands.push(PathBuf::from("/usr/local/bin/dlv"));
    for c in cands {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("dlv");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

struct Session {
    stream: TcpStream,
    child: Child,
}

#[derive(Default)]
pub struct DapManager {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: AtomicU64,
}

#[derive(Clone, Serialize)]
struct Msg {
    id: u64,
    body: String,
}

impl DapManager {
    /// Spawn `dlv dap` rooted at `root` and connect to it. Returns a session id
    /// the frontend uses to address frames and match `dap://*` events.
    pub fn start(&self, app: &AppHandle, root: String) -> Result<u64, String> {
        let bin = find_dlv().ok_or_else(|| {
            "dlv not found. Install it with `go install github.com/go-delve/delve/cmd/dlv@latest`."
                .to_string()
        })?;

        // dlv compiles the target with `go` before debugging; a GUI-launched
        // app's stripped PATH omits the toolchain, so splice it back in.
        let mut child = Command::new(&bin)
            .args(["dap", "--listen=127.0.0.1:0"])
            .current_dir(&root)
            .env("PATH", crate::run::go_child_path(&bin))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(e2s)?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut lines = BufReader::new(stdout).lines();

        // dlv announces "DAP server listening at: 127.0.0.1:<port>" once ready.
        let addr = loop {
            match lines.next() {
                Some(Ok(line)) => {
                    if let Some(rest) = line.split("listening at:").nth(1) {
                        break rest.trim().to_string();
                    }
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("dlv dap exited before listening".into());
                }
            }
        };

        // Keep draining dlv's stdout so its pipe never fills up.
        thread::spawn(move || for _ in lines.by_ref() {});

        let stream = TcpStream::connect(&addr).map_err(e2s)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        let reader_stream = stream.try_clone().map_err(e2s)?;
        let app = app.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader_stream);
            loop {
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            let _ = app.emit("dap://exit", id);
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
                    let _ = app.emit("dap://exit", id);
                    return;
                }
                let body = String::from_utf8_lossy(&buf).to_string();
                let _ = app.emit("dap://message", Msg { id, body });
            }
        });

        self.sessions.lock().unwrap().insert(id, Session { stream, child });
        Ok(id)
    }

    /// Frame and forward a raw DAP message to session `id`.
    pub fn send(&self, id: u64, body: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("no debug session")?;
        write!(s.stream, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(e2s)?;
        s.stream.flush().map_err(e2s)
    }

    pub fn stop(&self, id: u64) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(&id) {
            let _ = s.stream.shutdown(std::net::Shutdown::Both);
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

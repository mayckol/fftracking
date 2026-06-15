// Runs tests / programs (`go test`, `go run`) without the integrated terminal,
// streaming their output to the frontend over `run://*` events — the same
// emit-and-listen strategy the debug adapter uses, minus the DAP framing. One
// process at a time; starting a new run kills the previous (handled frontend-side).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Tauri apps inherit a stripped PATH, so probe the usual Go install locations
/// before falling back to a PATH search (mirrors dap::find_dlv).
fn find_go() -> Option<PathBuf> {
    let mut cands = vec![
        PathBuf::from("/usr/local/go/bin/go"),
        PathBuf::from("/opt/homebrew/bin/go"),
        PathBuf::from("/usr/local/bin/go"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        cands.push(PathBuf::from(&home).join("go").join("bin").join("go"));
    }
    for c in cands {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("go");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

#[derive(Default)]
pub struct RunManager {
    children: Arc<Mutex<HashMap<u64, Child>>>,
    next_id: AtomicU64,
}

#[derive(Clone, Serialize)]
struct Line {
    id: u64,
    kind: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u64,
    code: Option<i32>,
}

impl RunManager {
    pub fn start(
        &self,
        app: &AppHandle,
        cwd: String,
        program: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    ) -> Result<u64, String> {
        let bin = if program == "go" {
            find_go().ok_or_else(|| {
                "go not found. Install Go and make sure it is on your PATH.".to_string()
            })?
        } else {
            PathBuf::from(&program)
        };

        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Keep the toolchain dir on PATH so the child's own subprocesses resolve.
        if let Some(parent) = bin.parent() {
            let cur = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}:{}", parent.display(), cur));
        }
        // User-supplied env vars from the run config (override inherited ones).
        cmd.envs(env);

        let mut child = cmd.spawn().map_err(e2s)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();
        self.children.lock().unwrap().insert(id, child);

        if let Some(err) = stderr {
            spawn_reader(app.clone(), id, "err", err);
        }

        // stdout reader doubles as the reaper: when stdout closes the process is
        // exiting, so reap it (whichever of this thread / stop() wins the remove)
        // and report the exit code.
        let app = app.clone();
        let children = self.children.clone();
        thread::spawn(move || {
            pump(&app, id, "out", stdout);
            let reaped = children.lock().unwrap().remove(&id);
            if let Some(mut c) = reaped {
                let code = c.wait().ok().and_then(|s| s.code());
                let _ = app.emit("run://exit", Exit { id, code });
            }
        });

        Ok(id)
    }

    pub fn stop(&self, id: u64) {
        if let Some(mut c) = self.children.lock().unwrap().remove(&id) {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn spawn_reader(app: AppHandle, id: u64, kind: &'static str, stream: impl Read + Send + 'static) {
    thread::spawn(move || pump(&app, id, kind, stream));
}

fn pump(app: &AppHandle, id: u64, kind: &'static str, stream: impl Read) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let _ = app.emit(
                    "run://output",
                    Line { id, kind, text: line.clone() },
                );
            }
        }
    }
}

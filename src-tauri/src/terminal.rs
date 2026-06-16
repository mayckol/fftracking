use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The OS default interactive shell — $SHELL on Unix, %COMSPEC% on Windows.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<u64, Session>>,
    next: Mutex<u64>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u64,
    data: String,
}

impl TerminalManager {
    pub fn open(&self, app: &AppHandle, cwd: Option<String>, cols: u16, rows: u16) -> Result<u64, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(e2s)?;

        let mut cmd = CommandBuilder::new(default_shell());
        // Start a *login* shell so it sources the user's profile (zprofile /
        // bash_profile / fish login config). A GUI-launched app inherits a
        // stripped PATH; the login shell re-runs macOS path_helper and the
        // user's PATH setup, so tools like docker/docker-compose resolve here
        // exactly as they do in Warp/Terminal (which also open login shells).
        // bash, zsh, fish and dash all accept -l; Windows COMSPEC does not.
        if !cfg!(windows) {
            cmd.arg("-l");
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).map_err(e2s)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(e2s)?;
        let writer = pair.master.take_writer().map_err(e2s)?;

        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(id, Session { master: pair.master, writer, child });

        // Bytes are base64-encoded so terminal escape sequences and split
        // multibyte runs survive the JSON event channel intact.
        let app = app.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app.emit("terminal://exit", id);
                        break;
                    }
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("terminal://output", Output { id, data });
                    }
                }
            }
        });

        Ok(id)
    }

    pub fn write(&self, id: u64, data: &[u8]) -> Result<(), String> {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) {
            s.writer.write_all(data).map_err(e2s)?;
            s.writer.flush().map_err(e2s)?;
        }
        Ok(())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(s) = self.sessions.lock().unwrap().get(&id) {
            s.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(e2s)?;
        }
        Ok(())
    }

    pub fn close(&self, id: u64) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(&id) {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

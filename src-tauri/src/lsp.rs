// Generic LSP-over-stdio bridge. Runs multiple server kinds (gopls for Go,
// vtsls for JS/TS), one server per (workspace root, server) pair; the frontend
// builds JSON-RPC messages, this layer only frames them (`Content-Length`
// headers) and pumps stdout frames back as `lsp://message` events tagged with
// {root, server}. Mirrors the child-process pattern in terminal.rs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Identifies one language server instance: a workspace root + which server
/// runs there. Threaded as a single value through start/send/stop so the
/// `(root, server)` pair can never drift apart.
#[derive(Clone, Deserialize)]
pub struct LspTarget {
    pub root: String,
    pub server: String,
}

enum Kind {
    Gopls,
    Vtsls,
}

impl Kind {
    fn parse(s: &str) -> Result<Kind, String> {
        match s {
            "gopls" => Ok(Kind::Gopls),
            "vtsls" => Ok(Kind::Vtsls),
            other => Err(format!("unknown lsp server '{other}'")),
        }
    }
}

// ASCII unit separator — never appears in a path or a server name, so it can't
// collide when composing the map key.
const KEY_SEP: char = '\u{1f}';
fn compose_key(server: &str, root: &str) -> String {
    format!("{server}{KEY_SEP}{root}")
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

// Parse an nvm dir name like "v20.10.0" into (major, minor, patch) for ordering.
fn parse_node_version(name: &str) -> Option<(u64, u64, u64)> {
    let mut it = name.trim_start_matches('v').split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// Locate the system Node binary. GUI-launched apps inherit a stripped PATH
/// that omits Node, so probe absolute install locations (incl. version
/// managers) before a PATH search. vtsls and its tsserver workers need Node;
/// the run layer reuses this to resolve node/npm/npx/pnpm/yarn.
pub(crate) fn find_node() -> Option<PathBuf> {
    let mut cands = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        let h = PathBuf::from(&home);
        // Pick the newest nvm Node by NUMERIC version (a lexicographic sort would
        // rank v9 above v20 and hand vtsls an ancient runtime).
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            let newest = rd
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let ver = parse_node_version(&name)?;
                    let bin = e.path().join("bin/node");
                    bin.is_file().then_some((ver, bin))
                })
                .max_by_key(|(ver, _)| *ver);
            if let Some((_, bin)) = newest {
                cands.push(bin);
            }
        }
        cands.push(h.join(".volta/bin/node"));
        cands.push(h.join(".fnm/aliases/default/bin/node"));
    }
    for c in cands {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("node");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

// Path of the bundled vtsls entry relative to the resource dir. Must match the
// `bundle.resources` mapping in tauri.conf.json + scripts/bundle-vtsls.mjs.
const VTSLS_REL: &str = "resources/vtsls/node_modules/@vtsls/language-server/bin/vtsls.js";

/// Resolve the bundled vtsls.js. In a packaged app it lives under the resource
/// dir; under `tauri dev` resource resolution is unspecified, so fall back to
/// the staged tree beside the crate (the bundle script runs before dev/build).
/// Always a plain `.js` handed to `node` — never executed directly.
fn vtsls_entry(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = app.path().resolve(VTSLS_REL, BaseDirectory::Resource) {
        if p.is_file() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(VTSLS_REL);
    if dev.is_file() {
        return Ok(dev);
    }
    Err("Bundled vtsls not found. Run `npm run vtsls:bundle`.".into())
}

// vtsls failures (missing tsserver, bad config) surface only on stderr. Pipe it
// through during bring-up when FFTRACKING_LSP_DEBUG is set; otherwise discard.
fn vtsls_stderr() -> Stdio {
    if std::env::var_os("FFTRACKING_LSP_DEBUG").is_some() {
        Stdio::inherit()
    } else {
        Stdio::null()
    }
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
    server: String,
    body: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    root: String,
    server: String,
}

fn write_frame(stdin: &mut ChildStdin, body: &str) -> Result<(), String> {
    write!(stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(e2s)?;
    stdin.flush().map_err(e2s)
}

impl LspManager {
    /// Start the requested server for `target` if not already running.
    /// Idempotent per (root, server).
    pub fn start(&self, app: &AppHandle, target: LspTarget) -> Result<(), String> {
        let LspTarget { root, server } = target;
        let kind = Kind::parse(&server)?;
        let key = compose_key(&server, &root);

        // Resolve + configure the command before taking the lock (resource
        // lookup is fallible, and the critical section should stay short).
        let (mut cmd, stderr) = match kind {
            Kind::Gopls => {
                let bin = find_gopls().ok_or_else(|| {
                    "gopls not found. Install it with `go install golang.org/x/tools/gopls@latest`.".to_string()
                })?;
                // gopls shells out to the `go` toolchain for everything
                // (diagnostics, formatting, imports). A GUI-launched app has a
                // stripped PATH without it, so splice the toolchain back in.
                let mut c = Command::new(&bin);
                // Bound the gopls heap via the Go runtime soft memory limit. One
                // gopls runs per project root, so each must police itself (without
                // a limit a large module can balloon to multiple GB). Honor a
                // user-set GOMEMLIMIT; else default to a sane ceiling that
                // FFTRACKING_GOPLS_MEMLIMIT can override. Soft limit: gopls GCs
                // harder near it rather than crashing.
                let memlimit = std::env::var("GOMEMLIMIT")
                    .or_else(|_| std::env::var("FFTRACKING_GOPLS_MEMLIMIT"))
                    .unwrap_or_else(|_| "2GiB".into());
                c.current_dir(&root)
                    .env("PATH", crate::run::go_child_path(&bin))
                    .env("GOMEMLIMIT", &memlimit);
                (c, Stdio::null())
            }
            Kind::Vtsls => {
                let node = find_node().ok_or_else(|| {
                    "Node.js not found. Install Node 18+ (https://nodejs.org) to enable JS/TS support.".to_string()
                })?;
                let entry = vtsls_entry(app)?;
                let mut c = Command::new(&node);
                c.arg(&entry)
                    .arg("--stdio")
                    .current_dir(&root)
                    .env("PATH", crate::run::node_child_path(&node));
                (c, vtsls_stderr())
            }
        };

        let mut servers = self.servers.lock().unwrap();
        if servers.contains_key(&key) {
            return Ok(());
        }

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(e2s)?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let app = app.clone();
        let (r, srv) = (root.clone(), server.clone());
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            let _ = app.emit("lsp://exit", Exit { root: r.clone(), server: srv.clone() });
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
                    let _ = app.emit("lsp://exit", Exit { root: r.clone(), server: srv.clone() });
                    return;
                }
                let body = String::from_utf8_lossy(&buf).to_string();
                let _ = app.emit("lsp://message", Msg { root: r.clone(), server: srv.clone(), body });
            }
        });

        servers.insert(key, Server { stdin, child });
        Ok(())
    }

    /// Frame and forward a raw JSON-RPC message to the server for `target`.
    pub fn send(&self, target: &LspTarget, body: &str) -> Result<(), String> {
        let mut servers = self.servers.lock().unwrap();
        let s = servers
            .get_mut(&compose_key(&target.server, &target.root))
            .ok_or("no server for (root, server)")?;
        write_frame(&mut s.stdin, body)
    }

    pub fn stop(&self, target: &LspTarget) {
        if let Some(mut s) = self
            .servers
            .lock()
            .unwrap()
            .remove(&compose_key(&target.server, &target.root))
        {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

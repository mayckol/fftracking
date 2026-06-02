//! `fft` — headless CLI + MCP server for fftracking. Shares the desktop app's
//! data store, so anything an agent does here shows up live in the GUI.

mod mcp;
mod ops;

use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::Duration;

use chrono::{Local, TimeZone};
use clap::{Parser, Subcommand};
use ffcore::runner::MonitorManager;
use ffcore::Engine;
use serde_json::Value;

#[derive(Parser)]
#[command(
    name = "fft",
    version,
    about = "fftracking — local file-history & breaking-point tracker (CLI + MCP)",
    long_about = "fft drives fftracking from the terminal or from AI agents. It shares the same \
store as the desktop app, so tracked folders and breaking points stay in sync.\n\n\
A \"breaking point\" is a content snapshot of a tracked folder. Changes are shown against a base: \
the current git branch (HEAD) when the folder is a repo, otherwise the previous breaking point.",
    after_long_help = EXAMPLES,
    propagate_version = true
)]
struct Cli {
    /// Emit machine-readable JSON (for scripts / AI agents)
    #[arg(long, global = true)]
    json: bool,

    /// Data directory to use (defaults to the desktop app's store)
    #[arg(long, global = true, env = "FFTRACKING_DATA_DIR", value_name = "DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start tracking a folder (captures an initial breaking point)
    Track {
        /// Folder to track
        #[arg(long)]
        path: PathBuf,
        /// Seconds between timed snapshots (used by the desktop watcher)
        #[arg(long, default_value_t = 900)]
        interval: i64,
    },
    /// Capture a breaking point for a tracked folder right now
    Snapshot {
        #[arg(long)]
        path: PathBuf,
        /// Optional label for this breaking point
        #[arg(long)]
        label: Option<String>,
    },
    /// List all tracked folders
    List,
    /// List a folder's breaking points (newest first)
    Points {
        #[arg(long)]
        path: PathBuf,
        /// Max points to show
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Show files changed at a breaking point (vs git branch / previous point)
    Changes {
        #[arg(long)]
        path: PathBuf,
        /// Breaking-point id (defaults to the latest)
        #[arg(long)]
        point: Option<i64>,
    },
    /// Print a unified diff of a file at a breaking point
    Diff {
        #[arg(long)]
        path: PathBuf,
        /// File path relative to the tracked folder
        #[arg(long)]
        file: String,
        /// Breaking-point id (defaults to the latest)
        #[arg(long)]
        point: Option<i64>,
        /// Compare the point against the current working tree instead of the base
        #[arg(long)]
        now: bool,
    },
    /// Restore a file (or the whole point) to a breaking point's state
    Revert {
        #[arg(long)]
        path: PathBuf,
        /// Breaking-point id to restore from
        #[arg(long)]
        point: i64,
        /// File to revert
        #[arg(long)]
        file: Option<String>,
        /// Revert every file to the point
        #[arg(long)]
        all: bool,
    },
    /// Reset a file (or folder) to the current git branch (HEAD) — git repos only
    Reset {
        #[arg(long)]
        path: PathBuf,
        /// File to reset
        #[arg(long)]
        file: Option<String>,
        /// Reset every file under the folder
        #[arg(long)]
        all: bool,
        /// Also delete files not committed on the branch
        #[arg(long)]
        remove_extraneous: bool,
    },
    /// Set a label on a breaking point
    Label {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        point: i64,
        #[arg(long)]
        text: String,
    },
    /// Stop tracking a folder (use --purge to also delete its history)
    Untrack {
        #[arg(long)]
        path: PathBuf,
        /// Delete all breaking points too
        #[arg(long)]
        purge: bool,
    },
    /// Watch a folder in the foreground, capturing points on change (Ctrl-C to stop)
    Watch {
        #[arg(long)]
        path: PathBuf,
        #[arg(long, default_value_t = 900)]
        interval: i64,
    },
    /// Run as a Model Context Protocol server (stdio) for AI agents
    Mcp,
}

const EXAMPLES: &str = "\
EXAMPLES:
  fft track --path ~/proj                      start tracking a folder
  fft snapshot --path ~/proj --label \"pre-refactor\"
  fft points --path ~/proj                     list breaking points
  fft changes --path ~/proj                    what changed at the latest point
  fft diff --path ~/proj --file src/app.ts     diff a file (vs branch / prev point)
  fft revert --path ~/proj --point 42 --file src/app.ts
  fft reset  --path ~/proj --file src/app.ts   restore from the current git branch
  fft <cmd> --json                             machine-readable output

MCP (AI agents):
  Run `fft mcp` as a stdio server. Example client config:
    { \"mcpServers\": { \"fftracking\": { \"command\": \"fft\", \"args\": [\"mcp\"] } } }
";

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli) {
        eprintln!("error: {e}");
        exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let data_dir = match cli.data_dir {
        Some(d) => d,
        None => ops::default_data_dir()?,
    };
    let engine = Engine::open(&data_dir).map_err(|e| e.to_string())?;

    // Long-running / non-value commands handled directly.
    match &cli.command {
        Cmd::Mcp => return mcp::serve(&engine),
        Cmd::Watch { path, interval } => return watch(&engine, path, *interval),
        _ => {}
    }

    let result = match &cli.command {
        Cmd::Track { path, interval } => ops::track(&engine, path, *interval),
        Cmd::Snapshot { path, label } => ops::snapshot(&engine, path, label.as_deref()),
        Cmd::List => ops::list(&engine),
        Cmd::Points { path, limit } => ops::points(&engine, path, *limit),
        Cmd::Changes { path, point } => ops::changes(&engine, path, *point),
        Cmd::Diff { path, file, point, now } => ops::diff(&engine, path, file, *point, *now),
        Cmd::Revert { path, point, file, all } => ops::revert(&engine, path, *point, file.as_deref(), *all),
        Cmd::Reset { path, file, all, remove_extraneous } => {
            ops::reset(&engine, path, file.as_deref(), *all, *remove_extraneous)
        }
        Cmd::Label { path, point, text } => ops::label(&engine, path, *point, text),
        Cmd::Untrack { path, purge } => ops::untrack(&engine, path, *purge),
        Cmd::Mcp | Cmd::Watch { .. } => unreachable!(),
    }?;

    if cli.json {
        println!("{}", serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()));
    } else {
        print_human(&cli.command, &result);
    }
    Ok(())
}

fn watch(engine: &std::sync::Arc<Engine>, path: &Path, interval: i64) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let id = engine.add_monitor(path, interval, "manual").map_err(|e| e.to_string())?;
    engine.snapshot_now(id, "manual").map_err(|e| e.to_string())?;
    let manager = MonitorManager::new(engine.clone());
    manager.start(id, path, interval).map_err(|e| e.to_string())?;
    eprintln!(
        "watching {} (every {interval}s and on change) — Ctrl-C to stop",
        path.display()
    );
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn print_human(command: &Cmd, v: &Value) {
    match command {
        Cmd::Track { .. } => {
            println!(
                "Tracking {} (monitor {}){}",
                v["path"].as_str().unwrap_or(""),
                v["id"],
                if v["initial_point"].is_null() { "" } else { " — initial breaking point captured" }
            );
        }
        Cmd::Snapshot { .. } => {
            if v["created"].as_bool() == Some(true) {
                print!("Captured breaking point {}", v["point"]);
                if let Some(l) = v["label"].as_str() {
                    print!(" ({l})");
                }
                println!();
            } else {
                println!("No changes since the last breaking point");
            }
        }
        Cmd::List => {
            let rows = v.as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                println!("No folders tracked. Start with: fft track --path <dir>");
            }
            for m in rows {
                let base = match m["base"]["kind"].as_str() {
                    Some("git") => format!("⎇ {}", m["base"]["branch"].as_str().unwrap_or("?")),
                    _ => "previous point".to_string(),
                };
                println!(
                    "[{}] {}{}  ({})",
                    m["id"],
                    m["path"].as_str().unwrap_or(""),
                    if m["active"].as_bool() == Some(true) { "" } else { "  (stopped)" },
                    base
                );
            }
        }
        Cmd::Points { .. } => {
            let rows = v.as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                println!("No breaking points yet");
            }
            for p in rows {
                println!(
                    "#{:<5} {}  {:<9} {}{}",
                    p["id"],
                    fmt_ts(p["ts"].as_i64().unwrap_or(0)),
                    p["trigger"].as_str().unwrap_or(""),
                    summary(&p),
                    p["label"].as_str().map(|l| format!("  «{l}»")).unwrap_or_default(),
                );
            }
        }
        Cmd::Changes { .. } => {
            let base = match v["base"]["kind"].as_str() {
                Some("git") => format!("branch {}", v["base"]["branch"].as_str().unwrap_or("?")),
                _ => "the previous point".to_string(),
            };
            let files = v["files"].as_array().cloned().unwrap_or_default();
            println!("Point {} vs {base} — {} change(s)", v["point"], files.len());
            for f in files {
                let glyph = match f["status"].as_str() {
                    Some("added") => "A",
                    Some("deleted") => "D",
                    _ => "M",
                };
                println!("  {glyph}  {}", f["path"].as_str().unwrap_or(""));
            }
        }
        Cmd::Diff { .. } => {
            let d = v["diff"].as_str().unwrap_or("");
            if d.trim().is_empty() {
                println!("No differences ({} → {})", v["from"].as_str().unwrap_or(""), v["to"].as_str().unwrap_or(""));
            } else {
                print!("{d}");
            }
        }
        Cmd::Revert { .. } => println!("Reverted {} to point {}", target(&v["reverted"]), v["point"]),
        Cmd::Reset { .. } => println!(
            "Reset {} to branch {}",
            target(&v["reset"]),
            v["branch"].as_str().unwrap_or("?")
        ),
        Cmd::Label { .. } => println!("Labeled point {}: {}", v["point"], v["label"].as_str().unwrap_or("")),
        Cmd::Untrack { .. } => {
            if v["history_deleted"].as_bool() == Some(true) {
                println!("Stopped tracking and deleted history (monitor {})", v["monitor_id"]);
            } else {
                println!("Stopped tracking, history kept (monitor {})", v["monitor_id"]);
            }
        }
        Cmd::Mcp | Cmd::Watch { .. } => {}
    }
}

fn summary(p: &Value) -> String {
    let (a, m, d) = (p["added"].as_i64().unwrap_or(0), p["modified"].as_i64().unwrap_or(0), p["deleted"].as_i64().unwrap_or(0));
    let mut parts = Vec::new();
    if a > 0 {
        parts.push(format!("+{a}"));
    }
    if m > 0 {
        parts.push(format!("~{m}"));
    }
    if d > 0 {
        parts.push(format!("-{d}"));
    }
    if parts.is_empty() {
        format!("{} files", p["files"].as_i64().unwrap_or(0))
    } else {
        parts.join(" ")
    }
}

fn target(v: &Value) -> String {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "),
        Value::String(s) => s.clone(),
        _ => "?".to_string(),
    }
}

fn fmt_ts(ts: i64) -> String {
    match Local.timestamp_opt(ts, 0).single() {
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => ts.to_string(),
    }
}

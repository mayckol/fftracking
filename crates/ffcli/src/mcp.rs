//! Minimal Model Context Protocol server over stdio: newline-delimited
//! JSON-RPC 2.0, no async runtime. Exposes the same operations as the CLI as
//! MCP tools so an AI agent can track folders, capture breaking points, inspect
//! changes, and revert/reset — all against the desktop app's shared store.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use ffcore::Engine;
use serde_json::{json, Value};

use crate::ops;

const PROTOCOL_VERSION: &str = "2024-11-05";

pub fn serve(engine: &Engine) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                write(&mut stdout, &error(Value::Null, -32700, "parse error"))?;
                continue;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        if let Some(resp) = handle(engine, method, params, id.clone()) {
            write(&mut stdout, &resp)?;
        }
    }
    Ok(())
}

fn handle(engine: &Engine, method: &str, params: Value, id: Option<Value>) -> Option<Value> {
    // Notifications carry no id and never get a response.
    let id = id?;
    let resp = match method {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fftracking", "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": tool_defs() })),
        "tools/call" => tools_call(engine, params, id),
        _ => error(id, -32601, "method not found"),
    };
    Some(resp)
}

fn tools_call(engine: &Engine, params: Value, id: Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    match dispatch(engine, name, &args) {
        Ok(value) => ok(
            id,
            json!({ "content": [{ "type": "text", "text": pretty(&value) }] }),
        ),
        Err(msg) => ok(
            id,
            json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
        ),
    }
}

fn dispatch(engine: &Engine, name: &str, a: &Value) -> ops::OpResult {
    let path = || -> Result<PathBuf, String> {
        a.get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| "missing required argument: path".to_string())
    };
    let i64_of = |k: &str| a.get(k).and_then(Value::as_i64);
    let str_of = |k: &str| a.get(k).and_then(Value::as_str);
    let bool_of = |k: &str| a.get(k).and_then(Value::as_bool).unwrap_or(false);

    match name {
        "track" => ops::track(engine, &path()?, i64_of("interval").unwrap_or(900)),
        "snapshot" => ops::snapshot(engine, &path()?, str_of("label")),
        "list_monitors" => ops::list(engine),
        "points" => ops::points(engine, &path()?, i64_of("limit").unwrap_or(20).max(0) as usize),
        "changes" => ops::changes(engine, &path()?, i64_of("point")),
        "diff" => ops::diff(
            engine,
            &path()?,
            str_of("file").ok_or("missing required argument: file")?,
            i64_of("point"),
            bool_of("now"),
        ),
        "revert" => ops::revert(
            engine,
            &path()?,
            i64_of("point").ok_or("missing required argument: point")?,
            str_of("file"),
            bool_of("all"),
        ),
        "reset" => ops::reset(engine, &path()?, str_of("file"), bool_of("all"), bool_of("remove_extraneous")),
        "label" => ops::label(
            engine,
            &path()?,
            i64_of("point").ok_or("missing required argument: point")?,
            str_of("text").ok_or("missing required argument: text")?,
        ),
        "untrack" => ops::untrack(engine, &path()?, bool_of("purge")),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn tool_defs() -> Value {
    let s = |t: &str| json!({ "type": t });
    let path = ("path", "Absolute path of the tracked folder");
    json!([
        tool("track", "Start tracking a folder (captures an initial breaking point).",
            json!({ "path": desc(&s("string"), path.1), "interval": desc(&s("integer"), "Seconds between timed snapshots (default 900)") }),
            &["path"]),
        tool("snapshot", "Capture a breaking point for a tracked folder right now.",
            json!({ "path": desc(&s("string"), path.1), "label": desc(&s("string"), "Optional label for the breaking point") }),
            &["path"]),
        tool("list_monitors", "List all tracked folders and their comparison base.", json!({}), &[]),
        tool("points", "List a folder's breaking points with added/modified/deleted counts.",
            json!({ "path": desc(&s("string"), path.1), "limit": desc(&s("integer"), "Max points to return (default 20)") }),
            &["path"]),
        tool("changes", "List files changed at a breaking point vs its base (git branch or previous point). Defaults to the latest point.",
            json!({ "path": desc(&s("string"), path.1), "point": desc(&s("integer"), "Breaking-point id (default: latest)") }),
            &["path"]),
        tool("diff", "Unified diff of a file at a breaking point. `now` compares the point to the current working tree.",
            json!({ "path": desc(&s("string"), path.1), "file": desc(&s("string"), "File path relative to the tracked folder"), "point": desc(&s("integer"), "Breaking-point id (default: latest)"), "now": desc(&s("boolean"), "Compare point vs working tree instead of base vs point") }),
            &["path", "file"]),
        tool("revert", "Restore a file (or the whole point with all=true) to a breaking point's captured state.",
            json!({ "path": desc(&s("string"), path.1), "point": desc(&s("integer"), "Breaking-point id"), "file": desc(&s("string"), "File to revert (omit with all=true)"), "all": desc(&s("boolean"), "Revert every file to the point") }),
            &["path", "point"]),
        tool("reset", "Reset a file (or folder with all=true) to the current git branch (HEAD). Git repos only.",
            json!({ "path": desc(&s("string"), path.1), "file": desc(&s("string"), "File to reset (omit with all=true)"), "all": desc(&s("boolean"), "Reset every file under the folder"), "remove_extraneous": desc(&s("boolean"), "Also delete files not committed on the branch") }),
            &["path"]),
        tool("label", "Set a label on a breaking point.",
            json!({ "path": desc(&s("string"), path.1), "point": desc(&s("integer"), "Breaking-point id"), "text": desc(&s("string"), "Label text") }),
            &["path", "point", "text"]),
        tool("untrack", "Stop tracking a folder; purge=true also deletes its history.",
            json!({ "path": desc(&s("string"), path.1), "purge": desc(&s("boolean"), "Delete all breaking points too") }),
            &["path"]),
    ])
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

fn desc(schema: &Value, description: &str) -> Value {
    let mut s = schema.clone();
    s["description"] = json!(description);
    s
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

fn write(out: &mut impl Write, v: &Value) -> Result<(), String> {
    let line = serde_json::to_string(v).map_err(|e| e.to_string())?;
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}

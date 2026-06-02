use std::io::Write;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_fft");

fn run(data: &std::path::Path, args: &[&str]) -> (String, bool) {
    let out = Command::new(BIN)
        .args(args)
        .env("FFTRACKING_DATA_DIR", data)
        .output()
        .expect("run fft");
    (String::from_utf8_lossy(&out.stdout).into_owned(), out.status.success())
}

#[test]
fn cli_track_snapshot_changes_flow() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let p = proj.path().to_string_lossy().into_owned();
    std::fs::write(proj.path().join("a.txt"), "one\n").unwrap();

    let (out, ok) = run(data.path(), &["track", "--path", &p, "--json"]);
    assert!(ok, "track failed: {out}");
    assert!(out.contains("\"id\""), "track json: {out}");

    std::fs::write(proj.path().join("a.txt"), "two\n").unwrap();
    let (out, ok) = run(data.path(), &["snapshot", "--path", &p, "--json"]);
    assert!(ok && out.contains("\"created\": true"), "snapshot: {out}");

    // Non-git folder → compared against the previous breaking point.
    let (out, ok) = run(data.path(), &["changes", "--path", &p, "--json"]);
    assert!(ok, "changes failed: {out}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["base"]["kind"], "snapshot");
    let files = v["files"].as_array().unwrap();
    assert!(
        files.iter().any(|f| f["path"] == "a.txt" && f["status"] == "modified"),
        "expected a.txt modified, got {files:?}"
    );

    let (out, ok) = run(data.path(), &["list", "--json"]);
    assert!(ok && out.contains(&p), "list: {out}");
}

#[test]
fn mcp_initialize_and_lists_tools() {
    let data = tempfile::tempdir().unwrap();
    let mut child = Command::new(BIN)
        .arg("mcp")
        .env("FFTRACKING_DATA_DIR", data.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn mcp");

    let input = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"changes","arguments":{}}}"#,
        "\n",
    );
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().expect("mcp output");
    let stdout = String::from_utf8_lossy(&out.stdout);

    let lines: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("valid json-rpc line"))
        .collect();

    // The initialized notification gets no reply → exactly 3 responses.
    assert_eq!(lines.len(), 3, "got {stdout}");
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "fftracking");
    let tools = lines[1]["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "track"));
    assert!(tools.iter().any(|t| t["name"] == "reset"));
    // A tool error is reported in-band via isError, not as a protocol error.
    assert_eq!(lines[2]["result"]["isError"], true);
}

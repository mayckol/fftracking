use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use ffcore::ignore::{build_manifest, tree_signature};
use ffcore::runner::MonitorManager;
use ffcore::store::BlobStore;
use ffcore::Engine;

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

#[test]
fn manifest_honors_gitignore_and_builtins() {
    let proj = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let store = BlobStore::new(store_dir.path()).unwrap();
    let root = proj.path();

    write(root, "src/main.rs", "fn main() {}");
    write(root, "README.md", "# hi");
    write(root, ".gitignore", "secret.txt\n");
    write(root, "secret.txt", "do not track");
    write(root, "node_modules/dep/index.js", "x");
    write(root, "target/debug/app", "binary");

    // Opt-in: respect .gitignore — secret.txt excluded.
    let honor = build_manifest(root, &store, &[], true).unwrap();
    let honored: HashSet<&str> = honor.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(honored.contains("src/main.rs"));
    assert!(honored.contains("README.md"));
    assert!(!honored.contains("secret.txt"), "gitignored file excluded when respecting .gitignore");
    assert!(!honored.contains("node_modules/dep/index.js"), "node_modules always excluded");
    assert!(!honored.contains("target/debug/app"), "target always excluded");

    // Default (local-history): track everything — secret.txt included, builtins still skipped.
    let all = build_manifest(root, &store, &[], false).unwrap();
    let everything: HashSet<&str> = all.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(everything.contains("secret.txt"), "gitignored file tracked by default");
    assert!(!everything.contains("node_modules/dep/index.js"), "node_modules still excluded");
    assert!(!everything.contains("target/debug/app"), "target still excluded");
}

#[test]
fn snapshot_now_dedups_and_detects_change() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path()).unwrap();
    write(proj.path(), "a.txt", "one");
    let mid = engine.add_monitor(proj.path(), 900, "manual").unwrap();

    assert!(engine.snapshot_now(mid, "manual").unwrap().is_some());
    assert!(engine.snapshot_now(mid, "manual").unwrap().is_none(), "unchanged -> skipped");

    write(proj.path(), "a.txt", "two");
    assert!(engine.snapshot_now(mid, "manual").unwrap().is_some(), "change -> recorded");
}

#[test]
fn manager_event_watch_snapshots_on_change() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path()).unwrap();
    write(proj.path(), "seed.txt", "seed");
    let mid = engine.add_monitor(proj.path(), 3600, "manual").unwrap();
    engine.snapshot_now(mid, "manual").unwrap();

    let mgr = MonitorManager::new(engine.clone());
    mgr.start(mid, proj.path(), 3600).unwrap();

    // Give the watcher a moment to register, then make a change.
    std::thread::sleep(Duration::from_millis(300));
    write(proj.path(), "new.txt", "added");

    let count = |e: &Engine| -> i64 {
        e.with_db(|db| {
            Ok(db
                .conn
                .query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))?)
        })
        .unwrap()
    };

    let deadline = Instant::now() + Duration::from_secs(5);
    while count(&engine) < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(count(&engine) >= 2, "event watcher should record a snapshot after a change");

    mgr.stop_all();
}

#[test]
fn tree_signature_tracks_adds_edits_removes_and_is_stable() {
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    write(root, "src/main.rs", "fn main() {}");
    write(root, "README.md", "# hi");

    let sig = || tree_signature(root, &[], false).unwrap();
    let base = sig();
    assert_eq!(base, sig(), "unchanged tree -> stable fingerprint");

    write(root, "src/new.rs", "fn new() {}");
    let added = sig();
    assert_ne!(base, added, "added file changes fingerprint");

    write(root, "src/new.rs", "fn new() { todo!() }");
    assert_ne!(added, sig(), "edited content changes fingerprint");

    fs::rename(root.join("src/new.rs"), root.join("src/renamed.rs")).unwrap();
    let renamed = sig();
    assert_ne!(added, renamed, "rename changes fingerprint");

    fs::remove_file(root.join("src/renamed.rs")).unwrap();
    assert_eq!(base, sig(), "removing the added file restores the original fingerprint");
}

#[test]
fn tree_signature_excludes_builtin_dirs() {
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    write(root, "src/main.rs", "fn main() {}");
    let base = tree_signature(root, &[], false).unwrap();

    write(root, "node_modules/dep/index.js", "x");
    write(root, "target/debug/app", "binary");
    assert_eq!(base, tree_signature(root, &[], false).unwrap(), "ignored dirs don't affect the fingerprint");
}

#[test]
fn monitor_files_shows_glob_ignored_files() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path()).unwrap();
    write(proj.path(), "src/main.rs", "fn main() {}");
    write(proj.path(), "debug.log", "noise");
    write(proj.path(), "node_modules/dep/index.js", "x");
    let mid = engine.add_monitor(proj.path(), 900, "manual").unwrap();

    engine.with_db(|db| db.set_setting("ignore_globs", "*.log")).unwrap();

    let files = engine.monitor_files(mid).unwrap();
    assert!(files.contains(&"src/main.rs".to_string()));
    assert!(files.contains(&"debug.log".to_string()), "glob-ignored file still shows in the project tree");
    assert!(!files.iter().any(|f| f.starts_with("node_modules/")), "built-in dirs stay excluded from the tree");
}

use std::fs;
use std::path::Path;

use ffcore::Engine;

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

fn snap_count(e: &Engine) -> i64 {
    e.with_db(|db| Ok(db.conn.query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))?))
        .unwrap()
}

#[test]
fn revert_file_restores_and_takes_safety_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    write(root, "a.txt", "one");
    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    let s1 = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    // Unsnapshotted working-tree edits: reverting must capture them first.
    write(root, "a.txt", "two");
    let before = snap_count(&engine);

    engine.revert_file(s1, "a.txt").unwrap();
    assert_eq!(read(root, "a.txt"), "one");
    assert!(snap_count(&engine) > before, "uncaptured state is snapshotted before revert");
}

#[test]
fn revert_folder_restores_and_removes_extraneous() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    write(root, "a.txt", "one");
    write(root, "sub/x.txt", "x");
    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    let s1 = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    write(root, "a.txt", "two");
    write(root, "b.txt", "new file");
    engine.snapshot_now(mid, "manual").unwrap();

    engine.revert_folder(s1, "", true).unwrap();
    assert_eq!(read(root, "a.txt"), "one");
    assert_eq!(read(root, "sub/x.txt"), "x");
    assert!(!root.join("b.txt").exists(), "file absent in snapshot is removed");
}

#[test]
fn revert_single_hunk() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    write(root, "f.txt", "a\nb\nc\nd\n");
    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    let s1 = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    write(root, "f.txt", "A\nb\nC\nd\n"); // diverged in two regions
    let hunks = engine.file_hunks(s1, "f.txt").unwrap();
    assert_eq!(hunks.len(), 2);

    // Revert only the first hunk toward the snapshot; second stays diverged.
    engine.revert_hunks(s1, "f.txt", &[0]).unwrap();
    assert_eq!(read(root, "f.txt"), "a\nb\nC\nd\n");
}

use std::path::Path;
use std::process::Command;

use ffcore::query::ChangeStatus;
use ffcore::Engine;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn status_of<'a>(changes: &'a [ffcore::query::FileChange], path: &str) -> Option<ChangeStatus> {
    changes.iter().find(|c| c.path == path).map(|c| c.status)
}

#[test]
fn git_repo_compares_against_head_branch() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    git(root, &["init", "-q", "-b", "main"]);
    write(root, "keep.txt", "v1\n");
    write(root, "gone.txt", "bye\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    // First point is the baseline (clean working tree == HEAD) → no changes.
    let first = engine.snapshot_now(mid, "manual").unwrap().unwrap();
    assert!(engine.breaking_point_changes(mid, first).unwrap().is_empty());

    // Working-tree divergence from HEAD: modify, add, delete.
    write(root, "keep.txt", "v2\n");
    write(root, "new.txt", "fresh\n");
    std::fs::remove_file(root.join("gone.txt")).unwrap();
    let snap = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    let base = engine.base_info(mid).unwrap();
    assert_eq!(base.kind, "git");
    assert_eq!(base.branch.as_deref(), Some("main"));

    // Changes are computed against the current branch (HEAD), not the prior point.
    let ch = engine.breaking_point_changes(mid, snap).unwrap();
    assert_eq!(status_of(&ch, "keep.txt"), Some(ChangeStatus::Modified));
    assert_eq!(status_of(&ch, "new.txt"), Some(ChangeStatus::Added));
    assert_eq!(status_of(&ch, "gone.txt"), Some(ChangeStatus::Deleted));

    // Base content is the HEAD version.
    assert_eq!(engine.base_file(mid, snap, "keep.txt").unwrap().as_deref(), Some(b"v1\n".as_ref()));

    // Reset to branch: restores a deleted file, drops an uncommitted one,
    // reverts a modified one — the exact opposite of each change.
    engine.git_reset_file(mid, "gone.txt").unwrap();
    engine.git_reset_file(mid, "new.txt").unwrap();
    engine.git_reset_file(mid, "keep.txt").unwrap();
    assert_eq!(std::fs::read_to_string(root.join("gone.txt")).unwrap(), "bye\n");
    assert!(!root.join("new.txt").exists());
    assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(), "v1\n");
}

#[test]
fn non_git_folder_compares_against_previous_point() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    write(root, "a.txt", "one\n");
    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    let s1 = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    // The first breaking point is the baseline: no changes, not "all added".
    assert!(engine.breaking_point_changes(mid, s1).unwrap().is_empty());
    let first_summary = engine.snapshot_change_summaries(mid).unwrap();
    let s1sum = first_summary.iter().find(|s| s.id == s1).unwrap();
    assert_eq!((s1sum.added, s1sum.modified, s1sum.deleted), (0, 0, 0));

    write(root, "a.txt", "two\n");
    write(root, "b.txt", "new\n");
    let s2 = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    let base = engine.base_info(mid).unwrap();
    assert_eq!(base.kind, "snapshot");
    assert!(base.branch.is_none());

    let ch = engine.breaking_point_changes(mid, s2).unwrap();
    assert_eq!(status_of(&ch, "a.txt"), Some(ChangeStatus::Modified));
    assert_eq!(status_of(&ch, "b.txt"), Some(ChangeStatus::Added));
    assert_eq!(engine.base_file(mid, s2, "a.txt").unwrap().as_deref(), Some(b"one\n".as_ref()));

    let sums = engine.snapshot_change_summaries(mid).unwrap();
    let last = sums.iter().find(|s| s.id == s2).unwrap();
    assert_eq!((last.added, last.modified, last.deleted), (1, 1, 0));
}

#[test]
fn git_head_set_honors_user_ignore_globs() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    git(root, &["init", "-q", "-b", "main"]);
    write(root, "a.txt", "v1\n");
    write(root, "secret.log", "noise\n"); // committed, but the user ignores *.log
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    engine.set_setting("ignore_globs", "*.log").unwrap();
    let snap = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    // secret.log is excluded from BOTH the manifest and the HEAD base, so it must
    // not appear as a phantom deletion; a.txt is unchanged vs HEAD.
    let ch = engine.breaking_point_changes(mid, snap).unwrap();
    assert!(ch.is_empty(), "no phantom changes, got {ch:?}");
}

#[test]
fn git_subdirectory_monitor_scopes_to_its_prefix() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    git(root, &["init", "-q", "-b", "main"]);
    write(root, "top.txt", "root\n");
    write(root, "sub/a.txt", "v1\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    // Monitor only the subdirectory.
    let sub = root.join("sub");
    let mid = engine.add_monitor(&sub, 900, "manual").unwrap();
    engine.snapshot_now(mid, "manual").unwrap().unwrap(); // baseline (empty)
    write(root, "sub/a.txt", "v2\n");
    let snap = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    let base = engine.base_info(mid).unwrap();
    assert_eq!(base.kind, "git");

    // Diff is scoped to the subdir: a.txt modified, and the sibling top.txt
    // (above the prefix) is neither added nor deleted.
    let ch = engine.breaking_point_changes(mid, snap).unwrap();
    assert_eq!(status_of(&ch, "a.txt"), Some(ChangeStatus::Modified));
    assert!(ch.iter().all(|c| c.path != "top.txt" && c.path != "sub/a.txt"), "got {ch:?}");
    assert_eq!(engine.base_file(mid, snap, "a.txt").unwrap().as_deref(), Some(b"v1\n".as_ref()));
}

#[test]
fn git_ignored_files_excluded_from_branch_diff() {
    let data = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let root = proj.path();
    let engine = Engine::open(data.path()).unwrap();

    git(root, &["init", "-q", "-b", "main"]);
    write(root, ".gitignore", "*.log\n");
    write(root, "a.txt", "v1\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    // A git-ignored file present on disk — fftracking still tracks it for local
    // history (respect_gitignore is off by default), but it must NOT flood the
    // vs-branch diff as "added".
    write(root, "secret.log", "noise\n");

    let mid = engine.add_monitor(root, 900, "manual").unwrap();
    engine.snapshot_now(mid, "manual").unwrap().unwrap(); // baseline
    write(root, "a.txt", "v2\n");
    let snap = engine.snapshot_now(mid, "manual").unwrap().unwrap();

    let ch = engine.breaking_point_changes(mid, snap).unwrap();
    assert_eq!(status_of(&ch, "a.txt"), Some(ChangeStatus::Modified));
    assert!(
        ch.iter().all(|c| c.path != "secret.log"),
        "git-ignored file leaked into the vs-branch diff: {ch:?}"
    );
}

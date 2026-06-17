use std::path::Path;
use std::process::Command;

use ffcore::git::{
    accept_side, changed_files, commit, conflict_sides, conflicted_paths, file_at_rev, merge_blocks,
    merge_state, resolve_conflict, stage_paths, unstage_paths, working_status, WORKDIR,
};
use ffcore::query::ChangeStatus;

fn run_git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap()
        .success()
}

fn git(dir: &Path, args: &[&str]) {
    assert!(run_git(dir, args), "git {args:?} failed");
}

fn write(dir: &Path, rel: &str, content: &str) {
    std::fs::write(dir.join(rel), content).unwrap();
}

#[test]
fn diff_two_commits_and_read_blobs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);

    write(root, "a.txt", "one\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    write(root, "a.txt", "two\n");
    write(root, "b.txt", "added\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c2"]);

    let changes = changed_files(root, "HEAD~1", "HEAD").unwrap();
    let find = |p: &str| changes.iter().find(|c| c.path == p).map(|c| c.status);
    assert_eq!(find("a.txt"), Some(ChangeStatus::Modified));
    assert_eq!(find("b.txt"), Some(ChangeStatus::Added));

    assert_eq!(file_at_rev(root, "HEAD~1", "a.txt").unwrap().unwrap(), b"one\n");
    assert_eq!(file_at_rev(root, "HEAD", "a.txt").unwrap().unwrap(), b"two\n");

    // Working-tree compare picks up uncommitted edits.
    write(root, "a.txt", "three\n");
    let wd = changed_files(root, "HEAD", WORKDIR).unwrap();
    assert_eq!(wd.iter().find(|c| c.path == "a.txt").map(|c| c.status), Some(ChangeStatus::Modified));
    assert_eq!(file_at_rev(root, WORKDIR, "a.txt").unwrap().unwrap(), b"three\n");
}

#[test]
fn status_stage_unstage_commit_flow() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    write(root, "a.txt", "one\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "c1"]);

    // Modify a tracked file and add a new one.
    write(root, "a.txt", "two\n");
    write(root, "b.txt", "new\n");

    let st = working_status(root).unwrap();
    assert_eq!(st.branch, "main");
    assert!(st.staged.is_empty(), "nothing staged yet: {:?}", st.staged);
    let find = |v: &[ffcore::git::GitFileChange], p: &str| v.iter().find(|c| c.path == p).map(|c| c.status);
    assert_eq!(find(&st.unstaged, "a.txt"), Some(ChangeStatus::Modified));
    assert_eq!(find(&st.unstaged, "b.txt"), Some(ChangeStatus::Added));

    // Stage only b.txt.
    stage_paths(root, &["b.txt".into()]).unwrap();
    let st = working_status(root).unwrap();
    assert_eq!(find(&st.staged, "b.txt"), Some(ChangeStatus::Added));
    assert_eq!(find(&st.unstaged, "a.txt"), Some(ChangeStatus::Modified));
    assert!(find(&st.unstaged, "b.txt").is_none(), "b.txt should be fully staged");

    // Unstage it again.
    unstage_paths(root, &["b.txt".into()]).unwrap();
    assert!(working_status(root).unwrap().staged.is_empty());

    // Stage both and commit.
    stage_paths(root, &["a.txt".into(), "b.txt".into()]).unwrap();
    let oid = commit(root, "stage + commit").unwrap();
    assert_eq!(oid.len(), 12);
    let st = working_status(root).unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty(), "clean after commit: {st:?}");

    // Nothing staged now → commit errors.
    assert!(commit(root, "empty").is_err());
}

#[test]
fn detect_and_resolve_merge_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);

    write(root, "f.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);

    git(root, &["checkout", "-q", "-b", "feature"]);
    write(root, "f.txt", "from-feature\n");
    git(root, &["commit", "-q", "-am", "feature change"]);

    git(root, &["checkout", "-q", "main"]);
    write(root, "f.txt", "from-main\n");
    git(root, &["commit", "-q", "-am", "main change"]);

    // Merge conflicts; git exits non-zero, which is expected here.
    run_git(root, &["merge", "feature"]);

    let conflicts = conflicted_paths(root).unwrap();
    assert_eq!(conflicts, vec!["f.txt".to_string()]);

    resolve_conflict(root, "f.txt", "resolved\n").unwrap();
    assert!(conflicted_paths(root).unwrap().is_empty(), "conflict cleared after staging");
    assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "resolved\n");
}

/// Reusable: leaves `root` mid-merge with `f.txt` conflicted. `main` has
/// "from-main", `feature` has "from-feature", ancestor is "base".
fn setup_conflict(root: &Path) {
    git(root, &["init", "-q", "-b", "main"]);
    write(root, "f.txt", "L1\nbase\nL3\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);

    git(root, &["checkout", "-q", "-b", "feature"]);
    write(root, "f.txt", "L1\nfrom-feature\nL3\n");
    git(root, &["commit", "-q", "-am", "feature change"]);

    git(root, &["checkout", "-q", "main"]);
    write(root, "f.txt", "L1\nfrom-main\nL3\n");
    git(root, &["commit", "-q", "-am", "main change"]);

    run_git(root, &["merge", "feature"]);
}

#[test]
fn merge_state_reports_branches_and_sides() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    setup_conflict(root);

    let ms = merge_state(root).unwrap();
    assert_eq!(ms.ours_label, "main");
    assert_eq!(ms.theirs_label, "feature");
    assert_eq!(ms.files.len(), 1);
    assert_eq!(ms.files[0].path, "f.txt");
    assert_eq!(ms.files[0].ours, "modified");
    assert_eq!(ms.files[0].theirs, "modified");
}

#[test]
fn conflict_sides_and_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    setup_conflict(root);

    let sides = conflict_sides(root, "f.txt").unwrap();
    assert_eq!(sides.base.as_deref(), Some("L1\nbase\nL3\n"));
    assert_eq!(sides.ours.as_deref(), Some("L1\nfrom-main\nL3\n"));
    assert_eq!(sides.theirs.as_deref(), Some("L1\nfrom-feature\nL3\n"));

    let blocks = merge_blocks(root, "f.txt").unwrap();
    let conflicts: Vec<_> = blocks.iter().filter(|b| b.kind == "conflict").collect();
    assert_eq!(conflicts.len(), 1, "one conflicting region");
    assert_eq!(conflicts[0].ours.join("\n"), "from-main");
    assert_eq!(conflicts[0].theirs.join("\n"), "from-feature");
}

#[test]
fn accept_side_takes_whole_side() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    setup_conflict(root);

    accept_side(root, "f.txt", "theirs").unwrap();
    assert!(conflicted_paths(root).unwrap().is_empty(), "conflict cleared");
    assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "L1\nfrom-feature\nL3\n");
}

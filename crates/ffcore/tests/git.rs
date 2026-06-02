use std::path::Path;
use std::process::Command;

use ffcore::git::{changed_files, conflicted_paths, file_at_rev, resolve_conflict, WORKDIR};
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

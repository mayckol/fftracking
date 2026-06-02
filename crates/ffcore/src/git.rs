use std::path::Path;

use git2::{Delta, Repository, Tree};
use serde::Serialize;

use crate::query::ChangeStatus;
use crate::revert::{apply_hunks, hunks, HunkInfo};
use crate::{Error, Result};

/// Sentinel revspec meaning "the working tree as it is on disk right now".
pub const WORKDIR: &str = "WORKDIR";

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefList {
    pub branches: Vec<String>,
    pub commits: Vec<CommitInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitFileChange {
    pub path: String,
    pub status: ChangeStatus,
}

fn open(repo_path: &Path) -> Result<Repository> {
    Repository::open(repo_path).map_err(|e| Error::Msg(format!("open repo: {e}")))
}

pub fn list_refs(repo_path: &Path, commit_limit: usize) -> Result<RefList> {
    let repo = open(repo_path)?;

    let mut branches = Vec::new();
    for b in repo.branches(Some(git2::BranchType::Local))? {
        if let Ok(Some(name)) = b?.0.name() {
            branches.push(name.to_string());
        }
    }

    let mut commits = Vec::new();
    if let Ok(mut walk) = repo.revwalk() {
        if walk.push_head().is_ok() {
            for oid in walk.flatten().take(commit_limit) {
                if let Ok(c) = repo.find_commit(oid) {
                    commits.push(CommitInfo {
                        id: oid.to_string()[..12].to_string(),
                        summary: c.summary().unwrap_or("").to_string(),
                        time: c.time().seconds(),
                    });
                }
            }
        }
    }

    Ok(RefList { branches, commits })
}

fn tree_at<'r>(repo: &'r Repository, rev: &str) -> Result<Tree<'r>> {
    let obj = repo
        .revparse_single(rev)
        .map_err(|e| Error::Msg(format!("resolve '{rev}': {e}")))?;
    Ok(obj.peel_to_tree()?)
}

/// File-level changes between two revspecs. `to == WORKDIR` diffs the `from`
/// commit against the current working tree (including the index).
pub fn changed_files(repo_path: &Path, from: &str, to: &str) -> Result<Vec<GitFileChange>> {
    let repo = open(repo_path)?;
    let from_tree = tree_at(&repo, from)?;

    let diff = if to == WORKDIR {
        repo.diff_tree_to_workdir_with_index(Some(&from_tree), None)?
    } else {
        let to_tree = tree_at(&repo, to)?;
        repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)?
    };

    let mut out = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            Delta::Added | Delta::Copied | Delta::Untracked => ChangeStatus::Added,
            Delta::Deleted => ChangeStatus::Deleted,
            _ => ChangeStatus::Modified,
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string());
        if let Some(path) = path {
            out.push(GitFileChange { path, status });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    Ok(out)
}

fn workdir_path(repo: &Repository, rel: &str) -> Result<std::path::PathBuf> {
    Ok(repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repo has no working tree".into()))?
        .join(rel))
}

fn text_at(repo_path: &Path, rev: &str, path: &str) -> Result<String> {
    Ok(file_at_rev(repo_path, rev, path)?
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default())
}

/// Per-block changes for the displayed `from`→`to` diff. The hunk lines are on
/// the `to` (right/modified) side so revert icons line up with what's shown.
pub fn file_hunks(repo_path: &Path, from_rev: &str, to_rev: &str, path: &str) -> Result<Vec<HunkInfo>> {
    let to = text_at(repo_path, to_rev, path)?;
    let from = text_at(repo_path, from_rev, path)?;
    Ok(hunks(&to, &from))
}

/// Applies the `from` version of the selected blocks into the working-tree file
/// (taking `to` as the base, so the result matches the displayed right pane with
/// those blocks reverted to `from`). Works for any from/to, incl. branch↔branch.
pub fn revert_hunks(
    repo_path: &Path,
    from_rev: &str,
    to_rev: &str,
    path: &str,
    selected: &[usize],
) -> Result<()> {
    let to = text_at(repo_path, to_rev, path)?;
    let from = text_at(repo_path, from_rev, path)?;
    let (out, _) = apply_hunks(&to, &from, selected);
    let repo = open(repo_path)?;
    std::fs::write(workdir_path(&repo, path)?, out)?;
    Ok(())
}

/// Writes content to a working-tree file (in-diff edit / undo-redo persistence).
pub fn write_working(repo_path: &Path, path: &str, content: &str) -> Result<()> {
    let repo = open(repo_path)?;
    std::fs::write(workdir_path(&repo, path)?, content)?;
    Ok(())
}

/// Paths with unresolved merge conflicts (index conflict stages). Empty when no
/// merge is in progress. The on-disk file for each still contains the
/// `<<<<<<< / ======= / >>>>>>>` markers, read via [`file_at_rev`] with `WORKDIR`.
pub fn conflicted_paths(repo_path: &Path) -> Result<Vec<String>> {
    let repo = open(repo_path)?;
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for c in index.conflicts()? {
        let c = c?;
        let entry = c.our.or(c.their).or(c.ancestor);
        if let Some(e) = entry {
            paths.push(String::from_utf8_lossy(&e.path).into_owned());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Writes the resolved `content` to `path` and stages it, which clears the
/// conflict for that file (the index conflict stages collapse to stage 0).
pub fn resolve_conflict(repo_path: &Path, path: &str, content: &str) -> Result<()> {
    let repo = open(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repo has no working tree".into()))?;
    std::fs::write(workdir.join(path), content)?;
    let mut index = repo.index()?;
    index.add_path(Path::new(path))?;
    index.write()?;
    Ok(())
}

/// Bytes of `path` at `rev`. For `WORKDIR` reads from disk; returns `None` when
/// the file does not exist at that revision.
pub fn file_at_rev(repo_path: &Path, rev: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let repo = open(repo_path)?;
    if rev == WORKDIR {
        let p = repo
            .workdir()
            .ok_or_else(|| Error::Msg("bare repo has no working tree".into()))?
            .join(path);
        return Ok(std::fs::read(p).ok());
    }
    let tree = tree_at(&repo, rev)?;
    match tree.get_path(Path::new(path)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id())?;
            Ok(Some(blob.content().to_vec()))
        }
        Err(_) => Ok(None),
    }
}

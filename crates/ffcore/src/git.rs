use std::collections::HashMap;
use std::path::{Path, MAIN_SEPARATOR};

use git2::{Delta, DiffOptions, ObjectType, Repository, Tree, TreeWalkMode, TreeWalkResult};
use serde::Serialize;

use crate::query::ChangeStatus;
use crate::revert::{apply_hunks, hunks, HunkInfo};
use crate::{Error, Result};

/// Sentinel revspec meaning "the working tree as it is on disk right now".
pub const WORKDIR: &str = "WORKDIR";

/// The git repo a monitored folder lives in, with the folder's position inside
/// it. `prefix` is the monitored root relative to the repo working directory
/// ("" when the folder *is* the repo root), used to translate a monitor-relative
/// path to a repo-relative one. `submodules` are monitor-relative gitlink dirs
/// (their working trees belong to nested repos, not this one).
#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    pub repo_root: String,
    pub branch: String,
    pub prefix: String,
    pub head: Option<String>,
    pub submodules: Vec<String>,
}

impl GitInfo {
    /// Whether a monitor-relative path lives inside a submodule's working tree.
    pub fn under_submodule(&self, rel: &str) -> bool {
        self.submodules
            .iter()
            .any(|s| rel == s || rel.starts_with(&format!("{s}/")))
    }
}

/// Discovers the git repo containing `path` and reports its current branch and
/// the path's position within it. `None` when `path` is not inside a repo, or
/// when its scope within the repo can't be determined (so callers fall back to
/// breaking-point comparison rather than silently diffing against the whole repo).
pub fn repo_info(path: &Path) -> Option<GitInfo> {
    let repo = Repository::discover(path).ok()?;
    let workdir = repo.workdir()?.to_path_buf();
    let prefix = relative_prefix(path, &workdir)?;

    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .map(|oid| oid.to_string()[..12].to_string());

    let submodules = repo
        .submodules()
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let p = rel_string(s.path());
            // Keep only submodules under the monitored prefix, expressed
            // relative to it.
            if prefix.is_empty() {
                Some(p)
            } else if p == prefix {
                Some(String::new())
            } else {
                p.strip_prefix(&format!("{prefix}/")).map(str::to_string)
            }
        })
        .filter(|p| !p.is_empty())
        .collect();

    Some(GitInfo {
        repo_root: workdir.to_string_lossy().into_owned(),
        branch,
        prefix,
        head,
        submodules,
    })
}

/// The monitored root relative to the repo working dir, forward-slashed and
/// without a trailing slash. Tries a canonicalized compare first (so a symlinked
/// root like /var vs /private/var on macOS resolves), then a plain lexical
/// strip. `None` when `path` can't be shown to live under `workdir` — the caller
/// treats that as "not a usable git monitor" instead of assuming repo-root scope.
fn relative_prefix(path: &Path, workdir: &Path) -> Option<String> {
    if let (Ok(p), Ok(w)) = (path.canonicalize(), workdir.canonicalize()) {
        if let Ok(rel) = p.strip_prefix(&w) {
            return Some(rel_string(rel).trim_end_matches('/').to_string());
        }
    }
    path.strip_prefix(workdir)
        .ok()
        .map(|rel| rel_string(rel).trim_end_matches('/').to_string())
}

fn rel_string(p: &Path) -> String {
    p.to_string_lossy().replace(MAIN_SEPARATOR, "/")
}

fn join_prefix(prefix: &str, rel: &str) -> String {
    if prefix.is_empty() {
        rel.to_string()
    } else {
        format!("{prefix}/{rel}")
    }
}

/// Every blob in HEAD under `prefix`, keyed by path relative to `prefix` (i.e.
/// relative to the monitored root). `filter` applies the monitor's own capture
/// exclusions (built-in dirs, user globs, .gitignore) and oversized blobs are
/// dropped, so the result lines up with what the monitor actually snapshots and
/// the snapshot↔HEAD diff doesn't invent deletions. Empty on an unborn branch.
pub fn head_files(repo_path: &Path, prefix: &str, filter: &crate::ignore::PathFilter) -> Result<HashMap<String, Vec<u8>>> {
    let repo = open(repo_path)?;
    let Some(tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) else {
        return Ok(HashMap::new());
    };
    let pfx = if prefix.is_empty() { String::new() } else { format!("{prefix}/") };
    let mut out = HashMap::new();
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            let full = format!("{dir}{}", entry.name().unwrap_or(""));
            if (pfx.is_empty() || full.starts_with(&pfx)) && full.len() > pfx.len() {
                let rel = full[pfx.len()..].to_string();
                if !filter.ignored(&rel) {
                    if let Ok(blob) = repo.find_blob(entry.id()) {
                        let content = blob.content().to_vec();
                        if crate::ignore::within_size(content.len() as u64) {
                            out.insert(rel, content);
                        }
                    }
                }
            }
        }
        TreeWalkResult::Ok
    })?;
    Ok(out)
}

/// Which of `rels` (monitor-relative file paths) git ignores. fftracking tracks
/// git-ignored files for its own local history, but the vs-branch comparison
/// must not flag them as additions against the branch — they were never meant
/// to be committed. Tracked files are never reported ignored.
pub fn ignored_set(repo_path: &Path, prefix: &str, rels: &[String]) -> Result<std::collections::HashSet<String>> {
    let repo = open(repo_path)?;
    let mut out = std::collections::HashSet::new();
    for rel in rels {
        if repo.is_path_ignored(join_prefix(prefix, rel)).unwrap_or(false) {
            out.insert(rel.clone());
        }
    }
    Ok(out)
}

/// Bytes of a single monitor-relative path as committed in HEAD, or `None` when
/// HEAD has no such file (or no commits yet).
pub fn head_blob_at(repo_path: &Path, prefix: &str, rel: &str) -> Result<Option<Vec<u8>>> {
    let repo = open(repo_path)?;
    let Some(tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) else {
        return Ok(None);
    };
    match tree.get_path(Path::new(&join_prefix(prefix, rel))) {
        Ok(entry) => Ok(Some(repo.find_blob(entry.id())?.content().to_vec())),
        Err(_) => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefList {
    pub branches: Vec<String>,
    pub remote_branches: Vec<String>,
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

    let mut remote_branches = Vec::new();
    for b in repo.branches(Some(git2::BranchType::Remote))? {
        if let Ok(Some(name)) = b?.0.name() {
            // Skip the symbolic "origin/HEAD -> origin/main" pointer.
            if name.ends_with("/HEAD") {
                continue;
            }
            remote_branches.push(name.to_string());
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

    Ok(RefList { branches, remote_branches, commits })
}

fn tree_at<'r>(repo: &'r Repository, rev: &str) -> Result<Tree<'r>> {
    let obj = repo
        .revparse_single(rev)
        .map_err(|e| Error::Msg(format!("resolve '{rev}': {e}")))?;
    Ok(obj.peel_to_tree()?)
}

/// Switches the working tree to `name` (a local branch, tag, or commit). Uses a
/// safe checkout: it refuses rather than overwrite uncommitted local changes, so
/// switching never silently discards work — the caller surfaces the error.
pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<()> {
    let repo = open(repo_path)?;
    let (object, reference) = repo
        .revparse_ext(name)
        .map_err(|e| Error::Msg(format!("resolve '{name}': {e}")))?;
    let mut co = git2::build::CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(&object, Some(&mut co))
        .map_err(|e| Error::Msg(format!("checkout '{name}': {e}")))?;
    match reference.and_then(|r| r.name().map(str::to_string)) {
        Some(ref_name) => repo.set_head(&ref_name),
        None => repo.set_head_detached(object.id()),
    }
    .map_err(|e| Error::Msg(format!("set HEAD to '{name}': {e}")))?;
    Ok(())
}

/// File-level changes between two revspecs. `to == WORKDIR` diffs the `from`
/// commit against the current working tree (including the index).
pub fn changed_files(repo_path: &Path, from: &str, to: &str) -> Result<Vec<GitFileChange>> {
    let repo = open(repo_path)?;
    let from_tree = tree_at(&repo, from)?;

    let diff = if to == WORKDIR {
        // Untracked, non-ignored files count as additions — match the commit
        // panel's status, which lists them. Without this they're silently
        // dropped and HEAD → working tree reports zero changes.
        let mut opts = DiffOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        repo.diff_tree_to_workdir_with_index(Some(&from_tree), Some(&mut opts))?
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

/// Working-tree status split into what is staged (index vs HEAD) and what is not
/// (working tree vs index), plus the current branch — the data a commit panel needs.
#[derive(Debug, Clone, Serialize)]
pub struct WorkingStatus {
    pub branch: String,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    /// Unmerged paths (a merge/rebase left conflict markers). git2 reports these
    /// only as `CONFLICTED` — no INDEX_*/WT_* flag — so they belong in neither
    /// staged nor unstaged and would otherwise vanish from every changed view.
    pub conflicted: Vec<GitFileChange>,
}

fn index_status(s: git2::Status) -> Option<ChangeStatus> {
    if s.contains(git2::Status::INDEX_NEW) {
        Some(ChangeStatus::Added)
    } else if s.contains(git2::Status::INDEX_DELETED) {
        Some(ChangeStatus::Deleted)
    } else if s.intersects(git2::Status::INDEX_MODIFIED | git2::Status::INDEX_RENAMED | git2::Status::INDEX_TYPECHANGE) {
        Some(ChangeStatus::Modified)
    } else {
        None
    }
}

fn worktree_status(s: git2::Status) -> Option<ChangeStatus> {
    if s.contains(git2::Status::WT_NEW) {
        Some(ChangeStatus::Added)
    } else if s.contains(git2::Status::WT_DELETED) {
        Some(ChangeStatus::Deleted)
    } else if s.intersects(git2::Status::WT_MODIFIED | git2::Status::WT_RENAMED | git2::Status::WT_TYPECHANGE) {
        Some(ChangeStatus::Modified)
    } else {
        None
    }
}

pub fn working_status(repo_path: &Path) -> Result<WorkingStatus> {
    let repo = open(repo_path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicted = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path().map(str::to_string) else { continue };
        let s = entry.status();
        if s.contains(git2::Status::CONFLICTED) {
            conflicted.push(GitFileChange { path, status: ChangeStatus::Modified });
            continue;
        }
        if let Some(status) = index_status(s) {
            staged.push(GitFileChange { path: path.clone(), status });
        }
        if let Some(status) = worktree_status(s) {
            unstaged.push(GitFileChange { path, status });
        }
    }
    staged.sort_by(|a, b| a.path.cmp(&b.path));
    unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    conflicted.sort_by(|a, b| a.path.cmp(&b.path));

    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    Ok(WorkingStatus { branch, staged, unstaged, conflicted })
}

/// Stages each path: adds it to the index, or removes it from the index when the
/// file is gone from disk (a staged deletion).
pub fn stage_paths(repo_path: &Path, paths: &[String]) -> Result<()> {
    let repo = open(repo_path)?;
    let workdir = repo.workdir().ok_or_else(|| Error::Msg("bare repo has no working tree".into()))?.to_path_buf();
    let mut index = repo.index()?;
    for p in paths {
        let rel = Path::new(p);
        // symlink_metadata (not exists) so a broken symlink still counts as
        // present and is staged, rather than mistaken for a deletion.
        if workdir.join(rel).symlink_metadata().is_ok() {
            index.add_path(rel)?;
        } else {
            index.remove_path(rel)?;
        }
    }
    index.write()?;
    Ok(())
}

/// Unstages each path, resetting its index entry to HEAD (or dropping it from the
/// index when there is no commit yet).
pub fn unstage_paths(repo_path: &Path, paths: &[String]) -> Result<()> {
    let repo = open(repo_path)?;
    match repo.head().ok().and_then(|h| h.peel(git2::ObjectType::Commit).ok()) {
        Some(head) => repo.reset_default(Some(&head), paths.iter().map(String::as_str))?,
        None => {
            let mut index = repo.index()?;
            for p in paths {
                let _ = index.remove_path(Path::new(p));
            }
            index.write()?;
        }
    }
    Ok(())
}

/// Commits whatever is currently staged with `message`. Errors if the message is
/// empty, nothing is staged, or the committer identity is unset.
pub fn commit(repo_path: &Path, message: &str) -> Result<String> {
    if message.trim().is_empty() {
        return Err(Error::Msg("commit message is empty".into()));
    }
    let repo = open(repo_path)?;
    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("set git user.name and user.email to commit".into()))?;

    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    match &parent {
        Some(p) if p.tree_id() == tree_oid => {
            return Err(Error::Msg("nothing staged to commit".into()))
        }
        None if tree.len() == 0 => return Err(Error::Msg("nothing staged to commit".into())),
        _ => {}
    }

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(oid.to_string()[..12].to_string())
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

/// Discards working-tree changes to one file, restoring its committed (HEAD)
/// version — like `git checkout -- <file>`. A file with no HEAD version (newly
/// added / untracked) is removed.
pub fn discard_file(repo_path: &Path, path: &str) -> Result<()> {
    let repo = open(repo_path)?;
    let dest = workdir_path(&repo, path)?;
    match file_at_rev(repo_path, "HEAD", path)? {
        Some(content) => {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(dest, content)?;
        }
        None => {
            if dest.exists() {
                std::fs::remove_file(dest)?;
            }
        }
    }
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

/// One conflicted file with each side's change relative to the common ancestor.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub ours: String,
    pub theirs: String,
}

/// The in-progress merge: branch labels for each side and the conflicted files,
/// for the 3-way conflicts dialog.
#[derive(Debug, Clone, Serialize)]
pub struct MergeState {
    pub ours_label: String,
    pub theirs_label: String,
    pub files: Vec<ConflictFile>,
}

/// "modified" / "added" / "deleted" for one side, from whether the ancestor and
/// that side's blob are present in the conflict.
fn side_status(has_base: bool, has_side: bool) -> String {
    match (has_base, has_side) {
        (true, true) => "modified",
        (false, true) => "added",
        (true, false) => "deleted",
        (false, false) => "absent",
    }
    .to_string()
}

/// Best-effort branch name for `MERGE_HEAD` — the branch being merged in. Falls
/// back to a short commit id when no local branch points at it.
fn merge_head_label(repo: &Repository) -> Option<String> {
    let oid = repo
        .find_reference("MERGE_HEAD")
        .ok()
        .and_then(|r| r.target())
        .or_else(|| repo.revparse_single("MERGE_HEAD").ok().map(|o| o.id()))?;
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
        for b in branches.flatten() {
            if b.0.get().target() == Some(oid) {
                if let Ok(Some(name)) = b.0.name() {
                    return Some(name.to_string());
                }
            }
        }
    }
    Some(oid.to_string().chars().take(7).collect())
}

pub fn merge_state(repo_path: &Path) -> Result<MergeState> {
    let repo = open(repo_path)?;
    let ours_label = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let theirs_label = merge_head_label(&repo).unwrap_or_else(|| "merge".to_string());

    let index = repo.index()?;
    let mut files = Vec::new();
    if index.has_conflicts() {
        for c in index.conflicts()? {
            let c = c?;
            let Some(path) = c
                .our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            else {
                continue;
            };
            let has_base = c.ancestor.is_some();
            files.push(ConflictFile {
                path,
                ours: side_status(has_base, c.our.is_some()),
                theirs: side_status(has_base, c.their.is_some()),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(MergeState { ours_label, theirs_label, files })
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictSides {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

fn blob_text(repo: &Repository, entry: Option<&git2::IndexEntry>) -> Option<String> {
    let blob = repo.find_blob(entry?.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).into_owned())
}

/// The three conflicting versions (ancestor/ours/theirs) of `path` from the
/// index conflict stages. Any side absent (added on one side, deleted on the
/// other) comes back as `None`.
pub fn conflict_sides(repo_path: &Path, path: &str) -> Result<ConflictSides> {
    let repo = open(repo_path)?;
    conflict_sides_in(&repo, path)
}

fn conflict_sides_in(repo: &Repository, path: &str) -> Result<ConflictSides> {
    let index = repo.index()?;
    let target = path.as_bytes();
    for c in index.conflicts()? {
        let c = c?;
        let hit = [&c.ancestor, &c.our, &c.their]
            .iter()
            .any(|e| e.as_ref().is_some_and(|e| e.path == target));
        if hit {
            return Ok(ConflictSides {
                base: blob_text(repo, c.ancestor.as_ref()),
                ours: blob_text(repo, c.our.as_ref()),
                theirs: blob_text(repo, c.their.as_ref()),
            });
        }
    }
    Ok(ConflictSides { base: None, ours: None, theirs: None })
}

/// Diff3 blocks for a conflicted file, powering the three-pane merge editor.
pub fn merge_blocks(repo_path: &Path, path: &str) -> Result<Vec<crate::merge::MergeBlock>> {
    let s = conflict_sides(repo_path, path)?;
    Ok(crate::merge::diff3(
        s.base.as_deref().unwrap_or(""),
        s.ours.as_deref().unwrap_or(""),
        s.theirs.as_deref().unwrap_or(""),
    ))
}

/// Resolves a conflict by taking one whole side. `side` is `"ours"` or
/// `"theirs"`; when that side deleted the file it is removed from disk. Stages
/// the result, clearing the conflict.
pub fn accept_side(repo_path: &Path, path: &str, side: &str) -> Result<()> {
    let repo = open(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repo has no working tree".into()))?
        .to_path_buf();
    let sides = conflict_sides_in(&repo, path)?;
    let content = match side {
        "ours" => sides.ours,
        "theirs" => sides.theirs,
        _ => return Err(Error::Msg("side must be 'ours' or 'theirs'".into())),
    };
    let dest = workdir.join(path);
    let mut index = repo.index()?;
    match content {
        Some(text) => {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, text)?;
            index.add_path(Path::new(path))?;
        }
        None => {
            if dest.exists() {
                std::fs::remove_file(&dest)?;
            }
            index.remove_path(Path::new(path))?;
        }
    }
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

use std::path::{Path, MAIN_SEPARATOR};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{Match, WalkBuilder};

use crate::store::{BlobStore, Manifest};
use crate::Result;

/// Skipped everywhere regardless of any .gitignore. Heavy build/dependency
/// dirs and the like would bloat the store and slow every snapshot.
const BUILTIN_IGNORES: &[&str] = &[
    ".git",
    ".idea",
    ".DS_Store",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "__pycache__",
    "vendor",
    ".gradle",
    ".cache",
];

/// Files larger than this are skipped — local history is for source, not large
/// binaries, and storing them would burn through the disk cap fast.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Whether a committed (git HEAD) file is too large to participate in the
/// breaking-point vs-branch comparison (the monitor never captures it, so it
/// must not be reported as a deletion when diffing a snapshot against HEAD).
pub fn within_size(len: u64) -> bool {
    len <= MAX_FILE_BYTES
}

/// A path-testing matcher that mirrors the capture walk's path exclusions
/// (built-in dirs, user globs, and — when enabled — .gitignore). Unlike the
/// walker it tests arbitrary relative paths, so it can be applied to git HEAD
/// entries that may not currently exist on disk. Keeping both sides of the
/// snapshot↔HEAD diff on the same exclusion rules avoids phantom deletions.
pub struct PathFilter {
    ov: Override,
    gi: Option<Gitignore>,
}

impl PathFilter {
    pub fn build(root: &Path, extra_globs: &[String], respect_gitignore: bool) -> Result<Self> {
        let mut ovb = OverrideBuilder::new(root);
        for g in BUILTIN_IGNORES {
            ovb.add(&format!("!{g}"))?;
            ovb.add(&format!("!**/{g}/**"))?;
        }
        for g in extra_globs {
            ovb.add(&format!("!{g}"))?;
        }
        let gi = if respect_gitignore {
            let mut gb = GitignoreBuilder::new(root);
            gb.add(root.join(".gitignore"));
            Some(gb.build()?)
        } else {
            None
        };
        Ok(Self { ov: ovb.build()?, gi })
    }

    /// True when `rel` (forward-slash, treated as a file) would be skipped by
    /// the monitor's capture rules.
    pub fn ignored(&self, rel: &str) -> bool {
        if matches!(self.ov.matched(rel, false), Match::Ignore(_)) {
            return true;
        }
        matches!(&self.gi, Some(gi) if matches!(gi.matched(rel, false), Match::Ignore(_)))
    }
}

fn configure(root: &Path, extra_globs: &[String], respect_gitignore: bool) -> Result<WalkBuilder> {
    let mut ov = OverrideBuilder::new(root);
    // In an Override, a leading `!` means "ignore" (inverted vs gitignore).
    for g in BUILTIN_IGNORES {
        ov.add(&format!("!{g}"))?;
        ov.add(&format!("!**/{g}/**"))?;
    }
    for g in extra_globs {
        ov.add(&format!("!{g}"))?;
    }
    let mut wb = WalkBuilder::new(root);
    // Default: track everything (local-history semantics) — only heavy built-in
    // dirs, user globs, and the size cap exclude files. .gitignore is honored
    // only when the user opts in, so files like .env still get history.
    wb.hidden(false)
        .git_ignore(respect_gitignore)
        .git_exclude(respect_gitignore)
        .git_global(respect_gitignore)
        .parents(respect_gitignore)
        .require_git(false)
        .follow_links(false)
        .overrides(ov.build()?);
    Ok(wb)
}

/// Walks `root` (built-ins + user globs always; .gitignore only when
/// `respect_gitignore`) and writes every eligible file into `store`.
pub fn build_manifest(
    root: &Path,
    store: &BlobStore,
    extra_globs: &[String],
    respect_gitignore: bool,
) -> Result<Manifest> {
    let mut manifest = Manifest::default();
    for entry in configure(root, extra_globs, respect_gitignore)?.build() {
        let entry = entry?;
        let Some((rel, meta)) = eligible(root, &entry) else {
            continue;
        };
        let content = std::fs::read(entry.path())?;
        manifest.add_file(store, &rel, file_mode(&meta), &content)?;
    }
    Ok(manifest)
}

/// Relative paths of the same eligible files, without reading or storing them
/// (used to find files present on disk but absent from a snapshot).
pub fn list_paths(root: &Path, extra_globs: &[String], respect_gitignore: bool) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    for entry in configure(root, extra_globs, respect_gitignore)?.build() {
        let entry = entry?;
        if let Some((rel, _)) = eligible(root, &entry) {
            paths.push(rel);
        }
    }
    Ok(paths)
}

fn eligible(root: &Path, entry: &ignore::DirEntry) -> Option<(String, std::fs::Metadata)> {
    if !entry.file_type().is_some_and(|t| t.is_file()) {
        return None;
    }
    let meta = entry.metadata().ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let rel = entry.path().strip_prefix(root).ok()?;
    Some((rel.to_string_lossy().replace(MAIN_SEPARATOR, "/"), meta))
}

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> u32 {
    std::os::unix::fs::MetadataExt::mode(meta)
}

#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> u32 {
    0o644
}

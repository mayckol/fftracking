use std::fs;
use std::path::Path;

use serde::Serialize;
use similar::{DiffTag, TextDiff};

use crate::Result;

#[derive(Debug, Clone, Serialize)]
pub struct HunkInfo {
    pub index: usize,
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
}

/// Writes `content` to `root/rel`, creating parents; `None` deletes the file
/// (used when reverting to a state where the file did not yet exist).
pub fn apply_file(root: &Path, rel: &str, content: Option<&[u8]>) -> Result<()> {
    let dest = root.join(rel);
    match content {
        Some(bytes) => {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(dest, bytes)?;
        }
        None => {
            if dest.exists() {
                fs::remove_file(dest)?;
            }
        }
    }
    Ok(())
}

/// Hunks transforming `current` into `target`, line-based. The index ordering
/// matches [`apply_hunks`] so the UI can select hunks by index.
pub fn hunks(current: &str, target: &str) -> Vec<HunkInfo> {
    let diff = TextDiff::from_lines(current, target);
    let mut out = Vec::new();
    let mut index = 0;
    for op in diff.ops() {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        let old = op.old_range();
        let new = op.new_range();
        out.push(HunkInfo {
            index,
            old_start: old.start,
            old_len: old.len(),
            new_start: new.start,
            new_len: new.len(),
        });
        index += 1;
    }
    out
}

/// Applies only the `selected` hunks of the current→target diff: selected
/// regions take the target lines, the rest keep the current lines. Returns the
/// rebuilt text and the total hunk count (for validating selections).
pub fn apply_hunks(current: &str, target: &str, selected: &[usize]) -> (String, usize) {
    let diff = TextDiff::from_lines(current, target);
    let old_slices = diff.old_slices();
    let new_slices = diff.new_slices();

    let mut out = String::new();
    let mut index = 0;
    for op in diff.ops() {
        if op.tag() == DiffTag::Equal {
            out.extend(old_slices[op.old_range()].iter().copied());
            continue;
        }
        if selected.contains(&index) {
            out.extend(new_slices[op.new_range()].iter().copied());
        } else {
            out.extend(old_slices[op.old_range()].iter().copied());
        }
        index += 1;
    }
    (out, index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_selected_hunk_only() {
        let current = "a\nb\nc\nd\n";
        let target = "A\nb\nC\nd\n"; // two changed regions: line0 and line2
        let h = hunks(current, target);
        assert_eq!(h.len(), 2);

        let (only_first, total) = apply_hunks(current, target, &[0]);
        assert_eq!(total, 2);
        assert_eq!(only_first, "A\nb\nc\nd\n");

        let (both, _) = apply_hunks(current, target, &[0, 1]);
        assert_eq!(both, target);

        let (none, _) = apply_hunks(current, target, &[]);
        assert_eq!(none, current);
    }

}

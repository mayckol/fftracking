use std::fs;
use std::path::Path;

use serde::Serialize;
use similar::{DiffTag, TextDiff};

use crate::{Error, Result};

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

/// Splices the `index`-th block of the `from`→`to` diff into the `working` text,
/// leaving the rest of `working` untouched. Used to apply one change from a
/// two-revision compare (where neither pane is the working tree) into the live
/// file. The block's `from`-side region is located in `working` by line
/// alignment; if `working` has diverged there (the region was itself edited),
/// applying would be ambiguous, so this errors instead of corrupting the file.
pub fn apply_hunk_into(from: &str, to: &str, working: &str, index: usize) -> Result<String> {
    let ft = TextDiff::from_lines(from, to);
    let to_slices = ft.new_slices();

    // The index-th non-equal op, with its `from` line span and `to` replacement.
    let mut hi = 0;
    let mut target: Option<(std::ops::Range<usize>, std::ops::Range<usize>)> = None;
    for op in ft.ops() {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        if hi == index {
            target = Some((op.old_range(), op.new_range()));
            break;
        }
        hi += 1;
    }
    let (from_range, to_range) = target.ok_or_else(|| Error::Msg("hunk index out of range".into()))?;
    let repl = &to_slices[to_range];

    // Map each `from` line to its `working` line wherever the two agree (Equal
    // regions); index `from_len` is the end-of-file anchor for a trailing insert.
    let fw = TextDiff::from_lines(from, working);
    let work_slices = fw.new_slices();
    let from_len = fw.old_slices().len();
    let mut map: Vec<Option<usize>> = vec![None; from_len + 1];
    map[from_len] = Some(work_slices.len());
    for op in fw.ops() {
        if op.tag() == DiffTag::Equal {
            let a = op.old_range();
            let w = op.new_range();
            for k in 0..a.len() {
                map[a.start + k] = Some(w.start + k);
            }
        }
    }

    let diverged = || Error::Msg("the working tree has diverged in this block — apply it against the working tree instead".into());
    let (w0, w1) = if from_range.end > from_range.start {
        for f in from_range.clone() {
            if map[f].is_none() {
                return Err(diverged());
            }
        }
        (map[from_range.start].unwrap(), map[from_range.end - 1].unwrap() + 1)
    } else {
        let w = map[from_range.start].ok_or_else(diverged)?;
        (w, w)
    };

    let mut out: Vec<&str> = Vec::with_capacity(work_slices.len() + repl.len());
    out.extend_from_slice(&work_slices[..w0]);
    out.extend_from_slice(repl);
    out.extend_from_slice(&work_slices[w1..]);
    Ok(out.concat())
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

    #[test]
    fn apply_hunk_into_replacement_keeps_other_working_edits() {
        let from = "a\nb\nc\nd\n";
        let to = "a\nB\nc\nD\n"; // two hunks: line1 b→B, line3 d→D
        // Working has its own untouched edit on line a→a2; region around b/d intact.
        let working = "a2\nb\nc\nd\n";
        // Apply only the b→B hunk (index 0): working keeps a2 and d.
        let out = apply_hunk_into(from, to, working, 0).unwrap();
        assert_eq!(out, "a2\nB\nc\nd\n");
        // Apply only the d→D hunk (index 1).
        let out = apply_hunk_into(from, to, working, 1).unwrap();
        assert_eq!(out, "a2\nb\nc\nD\n");
    }

    #[test]
    fn apply_hunk_into_insertion() {
        let from = "a\nb\nc\n";
        let to = "a\nNEW\nb\nc\n"; // insert NEW after a
        let working = "a\nb\nc\nz\n"; // working added a trailing z
        let out = apply_hunk_into(from, to, working, 0).unwrap();
        assert_eq!(out, "a\nNEW\nb\nc\nz\n");
    }

    #[test]
    fn apply_hunk_into_trailing_insertion() {
        let from = "a\nb\n";
        let to = "a\nb\nTAIL\n"; // append at EOF
        let working = "a\nb\n";
        let out = apply_hunk_into(from, to, working, 0).unwrap();
        assert_eq!(out, "a\nb\nTAIL\n");
    }

    #[test]
    fn apply_hunk_into_diverged_region_errors() {
        let from = "a\nb\nc\n";
        let to = "a\nB\nc\n"; // change b→B
        let working = "a\nX\nc\n"; // working already changed b→X (diverged)
        assert!(apply_hunk_into(from, to, working, 0).is_err());
    }
}

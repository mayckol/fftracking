use serde::Serialize;
use similar::{DiffOp, TextDiff};

/// A contiguous region of a three-way merge.
///
/// `kind` is one of:
/// - `unchanged` — identical in base/ours/theirs (only `base` is filled).
/// - `ours` — changed by our side only (non-conflicting).
/// - `theirs` — changed by their side only (non-conflicting).
/// - `both` — both sides made the *same* change (non-conflicting).
/// - `conflict` — both sides changed the region differently.
///
/// Each side is line vectors (no trailing newline carried per line) so the
/// frontend can flat-concatenate and join with `\n` without ambiguity between an
/// empty region and a single blank line.
#[derive(Debug, Clone, Serialize)]
pub struct MergeBlock {
    pub kind: String,
    pub base: Vec<String>,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
}

#[derive(Clone, Copy)]
struct Hunk {
    o0: usize,
    o1: usize,
    s0: usize,
    s1: usize,
}

/// Changed regions transforming `base` into `side`, in base order.
fn changed_hunks(base: &[&str], side: &[&str]) -> Vec<Hunk> {
    let diff = TextDiff::from_slices(base, side);
    let mut out = Vec::new();
    for op in diff.ops() {
        match *op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { old_index, old_len, new_index } => {
                out.push(Hunk { o0: old_index, o1: old_index + old_len, s0: new_index, s1: new_index });
            }
            DiffOp::Insert { old_index, new_index, new_len } => {
                out.push(Hunk { o0: old_index, o1: old_index, s0: new_index, s1: new_index + new_len });
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                out.push(Hunk { o0: old_index, o1: old_index + old_len, s0: new_index, s1: new_index + new_len });
            }
        }
    }
    out
}

fn owned(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|s| s.to_string()).collect()
}

/// Split into lines on `\n`, dropping a trailing `\r` so CRLF content yields clean
/// lines. Without this a lone `\r` rides each line into the editor, where Monaco
/// treats it as a terminator and injects phantom blank lines on every applied hunk.
fn split_lines(s: &str) -> Vec<&str> {
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// Diff3 merge of `base`/`ours`/`theirs` into ordered [`MergeBlock`]s. The blocks
/// partition each side's lines in order, so concatenating any one side's lines
/// across blocks reproduces that side verbatim.
pub fn diff3(base_s: &str, ours_s: &str, theirs_s: &str) -> Vec<MergeBlock> {
    let base = split_lines(base_s);
    let ours = split_lines(ours_s);
    let theirs = split_lines(theirs_s);

    let ha = changed_hunks(&base, &ours);
    let hb = changed_hunks(&base, &theirs);

    let mut blocks: Vec<MergeBlock> = Vec::new();
    let (mut i, mut ai, mut bi) = (0usize, 0usize, 0usize);
    let (mut pa, mut pb) = (0usize, 0usize);

    loop {
        let na = ha.get(pa).map(|h| h.o0);
        let nb = hb.get(pb).map(|h| h.o0);
        let start = match (na, nb) {
            (None, None) => {
                if i < base.len() {
                    blocks.push(MergeBlock {
                        kind: "unchanged".into(),
                        base: owned(&base[i..]),
                        ours: Vec::new(),
                        theirs: Vec::new(),
                    });
                }
                break;
            }
            (Some(x), None) => x,
            (None, Some(y)) => y,
            (Some(x), Some(y)) => x.min(y),
        };

        if start > i {
            blocks.push(MergeBlock {
                kind: "unchanged".into(),
                base: owned(&base[i..start]),
                ours: Vec::new(),
                theirs: Vec::new(),
            });
            ai += start - i;
            bi += start - i;
            i = start;
        }

        // Grow the region to cover every hunk from either side that overlaps or
        // touches it, so interleaved edits land in one block.
        let (pa0, pb0) = (pa, pb);
        let mut end = i;
        loop {
            let mut extended = false;
            while pa < ha.len() && ha[pa].o0 <= end {
                end = end.max(ha[pa].o1);
                pa += 1;
                extended = true;
            }
            while pb < hb.len() && hb[pb].o0 <= end {
                end = end.max(hb[pb].o1);
                pb += 1;
                extended = true;
            }
            if !extended {
                break;
            }
        }

        let a_changed = pa > pa0;
        let b_changed = pb > pb0;
        let a_delta: isize = ha[pa0..pa].iter().map(|h| (h.s1 - h.s0) as isize - (h.o1 - h.o0) as isize).sum();
        let b_delta: isize = hb[pb0..pb].iter().map(|h| (h.s1 - h.s0) as isize - (h.o1 - h.o0) as isize).sum();
        let a_end = (ai as isize + (end - i) as isize + a_delta) as usize;
        let b_end = (bi as isize + (end - i) as isize + b_delta) as usize;

        let ours_region = &ours[ai..a_end];
        let theirs_region = &theirs[bi..b_end];
        let kind = match (a_changed, b_changed) {
            (true, false) => "ours",
            (false, true) => "theirs",
            (true, true) => {
                if ours_region == theirs_region {
                    "both"
                } else {
                    "conflict"
                }
            }
            (false, false) => "unchanged",
        };

        blocks.push(MergeBlock {
            kind: kind.into(),
            base: owned(&base[i..end]),
            ours: owned(ours_region),
            theirs: owned(theirs_region),
        });

        i = end;
        ai = a_end;
        bi = b_end;
    }

    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join(lines: &[String]) -> String {
        lines.join("\n")
    }

    // Each side reconstructs verbatim from its per-block lines.
    fn reconstructs(base: &str, ours: &str, theirs: &str) {
        let bl = diff3(base, ours, theirs);
        let pick = |f: fn(&MergeBlock) -> Vec<String>| {
            bl.iter().flat_map(|b| f(b)).collect::<Vec<_>>().join("\n")
        };
        let o = pick(|b| if b.kind == "unchanged" { b.base.clone() } else { b.ours.clone() });
        let t = pick(|b| if b.kind == "unchanged" { b.base.clone() } else { b.theirs.clone() });
        assert_eq!(o, ours, "ours reconstruction");
        assert_eq!(t, theirs, "theirs reconstruction");
    }

    #[test]
    fn ours_only_change() {
        let b = diff3("a\nb\nc", "a\nB\nc", "a\nb\nc");
        let change: Vec<_> = b.iter().filter(|x| x.kind != "unchanged").collect();
        assert_eq!(change.len(), 1);
        assert_eq!(change[0].kind, "ours");
        assert_eq!(join(&change[0].ours), "B");
        reconstructs("a\nb\nc", "a\nB\nc", "a\nb\nc");
    }

    #[test]
    fn theirs_only_change() {
        let b = diff3("a\nb\nc", "a\nb\nc", "a\nX\nc");
        assert!(b.iter().any(|x| x.kind == "theirs"));
        reconstructs("a\nb\nc", "a\nb\nc", "a\nX\nc");
    }

    #[test]
    fn same_change_both_sides() {
        let b = diff3("a\nb\nc", "a\nZ\nc", "a\nZ\nc");
        assert!(b.iter().any(|x| x.kind == "both"));
        assert!(!b.iter().any(|x| x.kind == "conflict"));
    }

    #[test]
    fn real_conflict() {
        let b = diff3("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc");
        let c: Vec<_> = b.iter().filter(|x| x.kind == "conflict").collect();
        assert_eq!(c.len(), 1);
        assert_eq!(join(&c[0].ours), "OURS");
        assert_eq!(join(&c[0].theirs), "THEIRS");
        reconstructs("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc");
    }

    #[test]
    fn disjoint_changes_dont_conflict() {
        let base = "1\n2\n3\n4\n5";
        let ours = "1\nOO\n3\n4\n5";
        let theirs = "1\n2\n3\nTT\n5";
        let b = diff3(base, ours, theirs);
        assert!(!b.iter().any(|x| x.kind == "conflict"));
        assert!(b.iter().any(|x| x.kind == "ours"));
        assert!(b.iter().any(|x| x.kind == "theirs"));
        reconstructs(base, ours, theirs);
    }

    #[test]
    fn added_lines_each_side() {
        reconstructs("a\nc", "a\nb\nc", "a\nc\nd");
    }

    #[test]
    fn crlf_lines_are_normalized() {
        let b = diff3("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n", "a\r\nb\r\nc\r\n");
        let change: Vec<_> = b.iter().filter(|x| x.kind != "unchanged").collect();
        assert_eq!(change.len(), 1);
        assert_eq!(change[0].kind, "ours");
        assert_eq!(change[0].ours, vec!["B".to_string()], "no trailing CR retained");
        assert!(
            b.iter().all(|bl| bl.base.iter().chain(&bl.ours).chain(&bl.theirs).all(|l| !l.contains('\r'))),
            "no block line carries a carriage return",
        );
    }

    #[test]
    fn one_sided_deletion_yields_empty_region() {
        // ours deletes the middle line; theirs leaves it. The change must contribute
        // zero `ours` lines so the editor can track it as an insertion anchor.
        let b = diff3("a\nx\nb", "a\nb", "a\nx\nb");
        let change: Vec<_> = b.iter().filter(|x| x.kind != "unchanged").collect();
        assert_eq!(change.len(), 1);
        assert_eq!(change[0].kind, "ours");
        assert!(change[0].ours.is_empty(), "deleted side contributes zero lines");
        assert_eq!(change[0].base, vec!["x".to_string()]);
        reconstructs("a\nx\nb", "a\nb", "a\nx\nb");
    }
}

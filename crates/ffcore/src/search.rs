//! Workspace full-text search, ripgrep-style: a parallel walk over the same
//! exclusion rules the capture uses, with grep's matcher/searcher underneath.
//! No persistent index — for monitor-sized source trees a cold parallel scan
//! finishes in tens of milliseconds, can never serve stale results, and costs
//! nothing while idle.

use std::path::{Path, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkState;
use serde::{Deserialize, Serialize};

use crate::ignore::MAX_FILE_BYTES;
use crate::Result;

/// Hard cap across the whole scan: enough to fill any results UI while keeping
/// a pathological query (e.g. regex `.`) from building a giant payload.
const MAX_MATCHES: usize = 2000;
/// Long minified lines are trimmed to a window around the match.
const MAX_LINE_CHARS: usize = 400;

#[derive(Debug, Clone, Deserialize)]
pub struct SearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    /// 1-based line number.
    pub line: u64,
    /// The matched line (trimmed of trailing newline, possibly windowed).
    pub text: String,
    /// First match span within `text`, in UTF-16 code units (JS string offsets).
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

fn escape_literal(q: &str) -> String {
    let mut out = String::with_capacity(q.len() * 2);
    for c in q.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn build_matcher(o: &SearchOptions) -> Result<RegexMatcher> {
    let pattern = if o.regex { o.query.clone() } else { escape_literal(&o.query) };
    RegexMatcherBuilder::new()
        .case_insensitive(!o.case_sensitive)
        .word(o.whole_word)
        .build(&pattern)
        .map_err(|e| crate::Error::Msg(format!("invalid pattern: {e}")))
}

/// UTF-16 length of `s` (how JS measures string offsets, so highlights line up
/// with what the webview renders).
fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Windows an over-long line around the byte span, returning the new text and
/// the span re-expressed in UTF-16 units.
fn window_line(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    if line.chars().count() <= MAX_LINE_CHARS {
        return (line.to_string(), utf16_len(&line[..start]), utf16_len(&line[..end]));
    }
    let lead = 80usize;
    let mut from = start;
    for _ in 0..lead {
        if from == 0 {
            break;
        }
        from -= 1;
        while !line.is_char_boundary(from) {
            from -= 1;
        }
    }
    let mut to = from;
    let mut count = 0;
    for (i, c) in line[from..].char_indices() {
        if count == MAX_LINE_CHARS {
            break;
        }
        to = from + i + c.len_utf8();
        count += 1;
    }
    let prefix = if from > 0 { "…" } else { "" };
    let suffix = if to < line.len() { "…" } else { "" };
    let text = format!("{prefix}{}{suffix}", &line[from..to]);
    let off = utf16_len(prefix);
    let s = off + utf16_len(&line[from..start]);
    let e = off + utf16_len(&line[from..end.min(to)]);
    (text, s, e)
}

pub fn search_content(
    root: &Path,
    opts: &SearchOptions,
    extra_globs: &[String],
    respect_gitignore: bool,
) -> Result<SearchResults> {
    if opts.query.is_empty() {
        return Ok(SearchResults { matches: Vec::new(), truncated: false });
    }
    let matcher = build_matcher(opts)?;
    let collected: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);

    crate::ignore::configure(root, extra_globs, respect_gitignore)?
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(12))
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            let collected = &collected;
            let count = &count;
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();
            Box::new(move |entry| {
                if count.load(Ordering::Relaxed) >= MAX_MATCHES {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                    return WalkState::Continue;
                }
                let rel = match entry.path().strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace(MAIN_SEPARATOR, "/"),
                    Err(_) => return WalkState::Continue,
                };
                let _ = searcher.search_path(
                    &matcher,
                    entry.path(),
                    UTF8(|line_no, line| {
                        if count.fetch_add(1, Ordering::Relaxed) >= MAX_MATCHES {
                            return Ok(false);
                        }
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        let (start, end) = match matcher.find(trimmed.as_bytes()) {
                            Ok(Some(m)) => (m.start(), m.end()),
                            _ => (0, 0),
                        };
                        let (text, s, e) = window_line(trimmed, start, end);
                        collected.lock().expect("search results mutex").push(SearchMatch {
                            path: rel.clone(),
                            line: line_no,
                            text,
                            start: s,
                            end: e,
                        });
                        Ok(true)
                    }),
                );
                if count.load(Ordering::Relaxed) >= MAX_MATCHES {
                    WalkState::Quit
                } else {
                    WalkState::Continue
                }
            })
        });

    let mut matches = collected.into_inner().expect("search results mutex");
    let truncated = matches.len() >= MAX_MATCHES;
    matches.truncate(MAX_MATCHES);
    // The parallel walk yields in nondeterministic order; sort for a stable UI.
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(SearchResults { matches, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(query: &str) -> SearchOptions {
        SearchOptions { query: query.into(), case_sensitive: false, regex: false, whole_word: false }
    }

    #[test]
    fn finds_literal_matches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world\nsecond Hello line\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "nothing here\n").unwrap();
        let r = search_content(dir.path(), &opts("hello"), &[], false).unwrap();
        assert_eq!(r.matches.len(), 2);
        assert_eq!(r.matches[0].path, "a.txt");
        assert_eq!(r.matches[0].line, 1);
        assert_eq!(&r.matches[0].text[r.matches[0].start..r.matches[0].end], "hello");
    }

    #[test]
    fn case_sensitive_and_word() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "Foo foobar foo\n").unwrap();
        let mut o = opts("foo");
        o.case_sensitive = true;
        o.whole_word = true;
        let r = search_content(dir.path(), &o, &[], false).unwrap();
        assert_eq!(r.matches.len(), 1);
    }

    #[test]
    fn regex_mode_and_literal_escaping() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "value(1)\nvalue(2)\nvalueX3.\n").unwrap();
        let mut o = opts(r"value\(\d\)");
        o.regex = true;
        assert_eq!(search_content(dir.path(), &o, &[], false).unwrap().matches.len(), 2);
        // Literal mode must not treat `(` as a group.
        assert_eq!(search_content(dir.path(), &opts("value(1)"), &[], false).unwrap().matches.len(), 1);
    }

    #[test]
    fn invalid_regex_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = opts("([");
        o.regex = true;
        assert!(search_content(dir.path(), &o, &[], false).is_err());
    }

    #[test]
    fn skips_binary_and_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bin.dat"), b"foo\x00foo").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.js"), "foo\n").unwrap();
        std::fs::write(dir.path().join("src.js"), "foo\n").unwrap();
        let r = search_content(dir.path(), &opts("foo"), &[], false).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].path, "src.js");
    }
}

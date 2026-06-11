//! Workspace full-text search, ripgrep-style: a parallel walk over the same
//! exclusion rules the capture uses, with grep's matcher/searcher underneath.
//! No persistent index — for monitor-sized source trees a cold parallel scan
//! finishes in tens of milliseconds, can never serve stale results, and costs
//! nothing while idle.

use std::path::{Path, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use grep_matcher::{Captures, Matcher};
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
    /// Root-relative folder to scope the search to (None/"" = whole tree).
    #[serde(default)]
    pub dir: Option<String>,
}

/// Walk pruning for a folder scope: directories keep walking only while they
/// are an ancestor or descendant of the scope; files must live inside it.
fn scoped(rel: &str, is_dir: bool, scope: &str) -> bool {
    if scope.is_empty() {
        return true;
    }
    if is_dir {
        rel.is_empty()
            || rel == scope
            || rel.starts_with(&format!("{scope}/"))
            || scope.starts_with(&format!("{rel}/"))
    } else {
        rel.starts_with(&format!("{scope}/"))
    }
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
        // ^/$ match per line, like the line-oriented searcher — keeps replace
        // (which runs over whole file contents) consistent with search results.
        .multi_line(true)
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
    let scope = opts.dir.as_deref().unwrap_or("").trim_matches('/').to_string();
    let collected: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);

    crate::ignore::configure(root, extra_globs, respect_gitignore)?
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(12))
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            let scope = &scope;
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
                let rel = match entry.path().strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace(MAIN_SEPARATOR, "/"),
                    Err(_) => return WalkState::Continue,
                };
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                if !scoped(&rel, is_dir, scope) {
                    return if is_dir { WalkState::Skip } else { WalkState::Continue };
                }
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                    return WalkState::Continue;
                }
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

#[derive(Debug, Clone, Deserialize)]
pub struct ReplaceSpec {
    pub options: SearchOptions,
    pub replacement: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReplaceMatchSpec {
    pub path: String,
    /// 1-based line number from a prior search result.
    pub line: u64,
    pub options: SearchOptions,
    pub replacement: String,
}

#[derive(Debug, Serialize)]
pub struct ReplaceSummary {
    pub files: usize,
    pub replacements: usize,
}

/// Replaces every match in `hay`, returning the new text and the match count
/// (None when nothing matched). In regex mode the replacement supports `$1`
/// capture references; in literal mode it is inserted verbatim.
fn replace_in_text(matcher: &RegexMatcher, hay: &str, spec: &ReplaceSpec) -> Option<(Vec<u8>, usize)> {
    let bytes = hay.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut caps = matcher.new_captures().expect("regex captures");
    let mut last = 0usize;
    let mut count = 0usize;
    matcher
        .captures_iter(bytes, &mut caps, |caps| {
            let m = caps.get(0).expect("whole-match capture");
            out.extend_from_slice(&bytes[last..m.start()]);
            if spec.options.regex {
                caps.interpolate(
                    |name| matcher.capture_index(name),
                    bytes,
                    spec.replacement.as_bytes(),
                    &mut out,
                );
            } else {
                out.extend_from_slice(spec.replacement.as_bytes());
            }
            last = m.end();
            count += 1;
            true
        })
        .expect("regex never errors");
    if count == 0 {
        return None;
    }
    out.extend_from_slice(&bytes[last..]);
    Some((out, count))
}

fn read_utf8(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Replaces the matches on one specific line of one file (a single result row
/// in the UI). Returns 0 when the line no longer matches — e.g. the file
/// changed since the search ran — so the caller can refresh instead of writing.
pub fn replace_match(root: &Path, spec: &ReplaceMatchSpec) -> Result<usize> {
    let matcher = build_matcher(&spec.options)?;
    let abs = root.join(&spec.path);
    let Some(content) = read_utf8(&abs) else {
        return Ok(0);
    };
    let mut start = 0usize;
    let mut end = content.len();
    let mut line_no = 0u64;
    for line in content.split_inclusive('\n') {
        line_no += 1;
        if line_no == spec.line {
            end = start + line.len();
            break;
        }
        start += line.len();
    }
    if line_no != spec.line {
        return Ok(0);
    }
    let rs = ReplaceSpec { options: spec.options.clone(), replacement: spec.replacement.clone() };
    let Some((replaced, count)) = replace_in_text(&matcher, &content[start..end], &rs) else {
        return Ok(0);
    };
    let mut out = Vec::with_capacity(content.len());
    out.extend_from_slice(content[..start].as_bytes());
    out.extend_from_slice(&replaced);
    out.extend_from_slice(content[end..].as_bytes());
    std::fs::write(&abs, out)?;
    Ok(count)
}

/// Replace across the whole tree, same walk and eligibility as search. Only
/// files that actually match are rewritten.
pub fn replace_all(
    root: &Path,
    spec: &ReplaceSpec,
    extra_globs: &[String],
    respect_gitignore: bool,
) -> Result<ReplaceSummary> {
    if spec.options.query.is_empty() {
        return Ok(ReplaceSummary { files: 0, replacements: 0 });
    }
    let matcher = build_matcher(&spec.options)?;
    let scope = spec.options.dir.as_deref().unwrap_or("").trim_matches('/').to_string();
    let files = AtomicUsize::new(0);
    let replacements = AtomicUsize::new(0);

    crate::ignore::configure(root, extra_globs, respect_gitignore)?
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(12))
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            let scope = &scope;
            let files = &files;
            let replacements = &replacements;
            Box::new(move |entry| {
                let Ok(entry) = entry else { return WalkState::Continue };
                let rel = match entry.path().strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace(MAIN_SEPARATOR, "/"),
                    Err(_) => return WalkState::Continue,
                };
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                if !scoped(&rel, is_dir, scope) {
                    return if is_dir { WalkState::Skip } else { WalkState::Continue };
                }
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                    return WalkState::Continue;
                }
                let Some(content) = read_utf8(entry.path()) else {
                    return WalkState::Continue;
                };
                if let Some((out, count)) = replace_in_text(&matcher, &content, spec) {
                    if std::fs::write(entry.path(), out).is_ok() {
                        files.fetch_add(1, Ordering::Relaxed);
                        replacements.fetch_add(count, Ordering::Relaxed);
                    }
                }
                WalkState::Continue
            })
        });

    Ok(ReplaceSummary {
        files: files.into_inner(),
        replacements: replacements.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(query: &str) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            case_sensitive: false,
            regex: false,
            whole_word: false,
            dir: None,
        }
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

    fn rspec(query: &str, replacement: &str, regex: bool) -> ReplaceSpec {
        let mut o = opts(query);
        o.regex = regex;
        ReplaceSpec { options: o, replacement: replacement.into() }
    }

    #[test]
    fn replace_all_literal_counts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo bar foo\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "no foo here\n").unwrap();
        std::fs::write(dir.path().join("c.txt"), "clean\n").unwrap();
        let r = replace_all(dir.path(), &rspec("foo", "qux", false), &[], false).unwrap();
        assert_eq!((r.files, r.replacements), (2, 3));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "qux bar qux\n");
        assert_eq!(std::fs::read_to_string(dir.path().join("c.txt")).unwrap(), "clean\n");
    }

    #[test]
    fn replace_regex_capture_groups() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "name: alice\nname: bob\n").unwrap();
        let r = replace_all(dir.path(), &rspec(r"name: (\w+)", "user=$1", true), &[], false).unwrap();
        assert_eq!(r.replacements, 2);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "user=alice\nuser=bob\n");
    }

    #[test]
    fn replace_literal_does_not_interpolate_dollar() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "price\n").unwrap();
        replace_all(dir.path(), &rspec("price", "$10", false), &[], false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "$10\n");
    }

    #[test]
    fn replace_single_match_targets_line_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo\nfoo foo\nfoo\n").unwrap();
        let mut o = opts("foo");
        o.case_sensitive = true;
        let spec = ReplaceMatchSpec { path: "a.txt".into(), line: 2, options: o, replacement: "bar".into() };
        assert_eq!(replace_match(dir.path(), &spec).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "foo\nbar bar\nfoo\n");
        // A line that no longer matches reports 0 and leaves the file alone.
        let stale = ReplaceMatchSpec { path: "a.txt".into(), line: 2, options: opts("foo").clone(), replacement: "x".into() };
        assert_eq!(replace_match(dir.path(), &stale).unwrap(), 0);
    }

    #[test]
    fn folder_scope_limits_search_and_replace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/lib")).unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("src/lib/a.txt"), "foo\n").unwrap();
        std::fs::write(dir.path().join("src/b.txt"), "foo\n").unwrap();
        std::fs::write(dir.path().join("docs/c.txt"), "foo\n").unwrap();

        let mut o = opts("foo");
        o.dir = Some("src/lib".into());
        let r = search_content(dir.path(), &o, &[], false).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].path, "src/lib/a.txt");

        o.dir = Some("src".into());
        let spec = ReplaceSpec { options: o, replacement: "bar".into() };
        let s = replace_all(dir.path(), &spec, &[], false).unwrap();
        assert_eq!((s.files, s.replacements), (2, 2));
        assert_eq!(std::fs::read_to_string(dir.path().join("docs/c.txt")).unwrap(), "foo\n");
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

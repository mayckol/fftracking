import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { fuzzyMatch, getRecents } from "../lib/fuzzy";
import type { SearchMatch } from "../lib/types";
import { basename, dirname } from "../lib/util";
import { FileIcon, FolderIcon } from "./Icons";

export type PaletteMode = "files" | "text";

interface Props {
  monitorId: number;
  mode: PaletteMode;
  /** Seeds the query when the palette opens (editor selection at invoke time). */
  initialQuery?: string;
  /** Root-relative folder to scope text search/replace to. */
  initialScope?: string | null;
  /** Bumps when ⌘⇧R fires; >0 opens the replace row. */
  replaceReq?: number;
  onModeChange: (mode: PaletteMode) => void;
  onClose: () => void;
  onOpenFile: (path: string, line?: number, col?: number) => void;
  onRevealFolder: (path: string) => void;
}

interface FileEntry {
  path: string;
  isDir: boolean;
}

interface FileRow extends FileEntry {
  positions: number[];
}

const MAX_ROWS = 60;
const DEBOUNCE_MS = 180;

/** Splits `text` into plain/highlighted runs from sorted match positions. */
function highlightAt(text: string, positions: number[]) {
  if (positions.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  while (i < positions.length) {
    let j = i;
    while (j + 1 < positions.length && positions[j + 1] === positions[j] + 1) j++;
    const from = positions[i];
    const to = positions[j] + 1;
    if (from > last) out.push(text.slice(last, from));
    out.push(<b key={from}>{text.slice(from, to)}</b>);
    last = to;
    i = j + 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export default function SearchPalette({
  monitorId,
  mode,
  initialQuery = "",
  initialScope = null,
  replaceReq = 0,
  onModeChange,
  onClose,
  onOpenFile,
  onRevealFolder,
}: Props) {
  // Seed once on mount; the input is focused+selected, so typing overwrites it.
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<string | null>(initialScope);
  const [sel, setSel] = useState(0);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [replaceOn, setReplaceOn] = useState(replaceReq > 0);
  const [replacement, setReplacement] = useState("");
  // Two-step confirm for replace-all (window.confirm is dead in the webview).
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (replaceReq > 0) setReplaceOn(true);
  }, [replaceReq]);

  const options = { query, case_sensitive: caseSensitive, regex, whole_word: wholeWord, dir: scope };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  // Window-level so Esc closes no matter where focus ended up (clicking a
  // result row blurs the input, so the palette's own keydown never fires).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [onClose]);

  // File list for quick open: one walk when the palette opens, then every
  // keystroke matches in memory. Folders are derived from the file paths.
  useEffect(() => {
    if (mode !== "files" || entries) return;
    let alive = true;
    api
      .monitorFiles(monitorId)
      .then((files) => {
        if (!alive) return;
        const dirs = new Set<string>();
        for (const f of files) {
          let d = dirname(f).replace(/\/$/, "");
          while (d && !dirs.has(d)) {
            dirs.add(d);
            d = dirname(d).replace(/\/$/, "");
          }
        }
        setEntries([
          ...files.map((path) => ({ path, isDir: false })),
          ...[...dirs].map((path) => ({ path, isDir: true })),
        ]);
      })
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [mode, entries, monitorId]);

  const fileRows: FileRow[] = useMemo(() => {
    if (mode !== "files" || !entries) return [];
    const recents = getRecents(monitorId);
    const recentRank = new Map(recents.map((p, i) => [p, i]));
    if (!query) {
      // Empty query: recently opened files first, then shallow paths.
      const rest = entries
        .filter((e) => !recentRank.has(e.path))
        .sort((a, b) => {
          const da = a.path.split("/").length - b.path.split("/").length;
          return da !== 0 ? da : a.path.localeCompare(b.path);
        });
      const recent = recents
        .map((p) => entries.find((e) => e.path === p && !e.isDir))
        .filter((e): e is FileEntry => !!e);
      return [...recent, ...rest].slice(0, MAX_ROWS).map((e) => ({ ...e, positions: [] }));
    }
    const scored: { row: FileRow; score: number }[] = [];
    for (const e of entries) {
      const hit = fuzzyMatch(query, e.path);
      if (!hit) continue;
      let score = hit.score;
      // Matching the basename outranks matching scattered path segments.
      const base = basename(e.path);
      const baseHit = fuzzyMatch(query, base);
      if (baseHit) score += baseHit.score + 24;
      const r = recentRank.get(e.path);
      if (r !== undefined) score += Math.max(0, 30 - r * 2);
      scored.push({ row: { ...e, positions: hit.positions }, score });
    }
    scored.sort((a, b) => b.score - a.score || a.row.path.length - b.row.path.length);
    return scored.slice(0, MAX_ROWS).map((s) => s.row);
  }, [mode, entries, query, monitorId]);

  // Content search: debounce, and drop responses that arrive out of order.
  useEffect(() => {
    if (mode !== "text") return;
    const seq = ++searchSeq.current;
    if (!query) {
      setMatches([]);
      setTruncated(false);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      api
        .searchContent(monitorId, {
          query,
          case_sensitive: caseSensitive,
          regex,
          whole_word: wholeWord,
          dir: scope,
        })
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setMatches(r.matches);
          setTruncated(r.truncated);
          setSearchErr(null);
          setSearching(false);
        })
        .catch((e) => {
          if (seq !== searchSeq.current) return;
          setMatches([]);
          setTruncated(false);
          setSearchErr(String(e));
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [mode, query, caseSensitive, regex, wholeWord, scope, monitorId, refresh]);

  // A different query/options invalidates both the armed confirm and the last
  // replace report.
  useEffect(() => {
    setArmed(false);
    setReplaceMsg(null);
  }, [query, caseSensitive, regex, wholeWord, scope, mode]);

  async function replaceSelected() {
    const m = matches[sel];
    if (!m || busy || !query) return;
    setBusy(true);
    try {
      const n = await api.replaceMatch(monitorId, {
        path: m.path,
        line: m.line,
        options,
        replacement,
      });
      setReplaceMsg(
        n > 0
          ? `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${m.path}:${m.line}`
          : "Line changed on disk — nothing replaced, results refreshed",
      );
    } catch (e) {
      setReplaceMsg(String(e));
    } finally {
      setBusy(false);
      setRefresh((r) => r + 1);
    }
  }

  async function replaceAllClick() {
    if (busy || !query || matches.length === 0) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    try {
      const r = await api.replaceAll(monitorId, { options, replacement });
      setReplaceMsg(
        `Replaced ${r.replacements} match${r.replacements === 1 ? "" : "es"} in ${r.files} file${
          r.files === 1 ? "" : "s"
        } · breaking point captured first`,
      );
    } catch (e) {
      setReplaceMsg(String(e));
    } finally {
      setBusy(false);
      setRefresh((r) => r + 1);
    }
  }

  const rowCount = mode === "files" ? fileRows.length : matches.length;
  useEffect(() => setSel(0), [query, mode]);
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, rowCount - 1))), [rowCount]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const accept = (i: number) => {
    if (mode === "files") {
      const row = fileRows[i];
      if (!row) return;
      if (row.isDir) onRevealFolder(row.path);
      else onOpenFile(row.path);
    } else {
      const m = matches[i];
      if (!m) return;
      onOpenFile(m.path, m.line, m.start + 1);
    }
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(rowCount - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      accept(sel);
    }
  };

  // Group text matches by file for display while keeping flat row indices for
  // keyboard navigation.
  const grouped = useMemo(() => {
    const out: { path: string; from: number; items: SearchMatch[] }[] = [];
    matches.forEach((m, i) => {
      const last = out[out.length - 1];
      if (last && last.path === m.path) last.items.push(m);
      else out.push({ path: m.path, from: i, items: [m] });
    });
    return out;
  }, [matches]);

  return (
    <div className="modal-overlay palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-head">
          <div className="palette-tabs">
            <button className={mode === "files" ? "on" : ""} onClick={() => onModeChange("files")}>
              Files
            </button>
            <button className={mode === "text" ? "on" : ""} onClick={() => onModeChange("text")}>
              Text
            </button>
          </div>
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder={mode === "files" ? "Search files and folders by name…" : "Search text in files…"}
            onChange={(e) => setQuery(e.target.value)}
          />
          {mode === "text" && (
            <div className="palette-opts">
              <button
                className={caseSensitive ? "on" : ""}
                title="Match case"
                onClick={() => setCaseSensitive((v) => !v)}
              >
                Aa
              </button>
              <button
                className={wholeWord ? "on" : ""}
                title="Whole word"
                onClick={() => setWholeWord((v) => !v)}
              >
                ⌊w⌋
              </button>
              <button className={regex ? "on" : ""} title="Regular expression" onClick={() => setRegex((v) => !v)}>
                .*
              </button>
              <button
                className={replaceOn ? "on" : ""}
                title="Toggle replace"
                onClick={() => setReplaceOn((v) => !v)}
              >
                ⇄
              </button>
            </div>
          )}
        </div>

        {mode === "text" && scope && (
          <div className="palette-scope">
            <span>
              in <code>{scope}/</code>
            </span>
            <button title="Search the whole workspace instead" onClick={() => setScope(null)}>
              × clear
            </button>
          </div>
        )}

        {mode === "text" && replaceOn && (
          <div className="palette-replace">
            <input
              value={replacement}
              spellCheck={false}
              placeholder={regex ? "Replace with… ($1 for groups)" : "Replace with…"}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  replaceSelected();
                }
              }}
            />
            <button
              className="tbtn"
              disabled={busy || !matches[sel]}
              title="Replace the matches on the selected line (↵ in this field)"
              onClick={replaceSelected}
            >
              Replace
            </button>
            <button
              className={`tbtn${armed ? " danger" : ""}`}
              disabled={busy || matches.length === 0}
              title="Replace every match in the workspace (a breaking point is captured first)"
              onClick={replaceAllClick}
            >
              {armed ? `Confirm: replace ${matches.length}${truncated ? "+" : ""}` : "Replace all"}
            </button>
          </div>
        )}

        <div className="palette-list" ref={listRef}>
          {mode === "files" ? (
            entries === null ? (
              <div className="palette-note">Indexing files…</div>
            ) : fileRows.length === 0 ? (
              <div className="palette-note">No matches</div>
            ) : (
              fileRows.map((r, i) => (
                <div
                  key={`${r.isDir ? "d" : "f"}:${r.path}`}
                  data-row={i}
                  className={`palette-row${i === sel ? " on" : ""}`}
                  onMouseMove={() => setSel(i)}
                  onClick={() => accept(i)}
                >
                  {r.isDir ? <FolderIcon /> : <FileIcon />}
                  <span className="palette-name">{highlightAt(r.path, r.positions)}</span>
                  {r.isDir && <span className="palette-hint">reveal</span>}
                </div>
              ))
            )
          ) : searchErr ? (
            <div className="palette-note error">{searchErr}</div>
          ) : !query ? (
            <div className="palette-note">Type to search file contents.</div>
          ) : matches.length === 0 ? (
            <div className="palette-note">{searching ? "Searching…" : "No matches"}</div>
          ) : (
            grouped.map((g) => (
              <div key={g.path} className="palette-group">
                <div className="palette-file">
                  <FileIcon />
                  <span className="palette-name">{g.path}</span>
                  <span className="palette-count">{g.items.length}</span>
                </div>
                {g.items.map((m, k) => {
                  const i = g.from + k;
                  return (
                    <div
                      key={`${m.line}:${k}`}
                      data-row={i}
                      className={`palette-row match${i === sel ? " on" : ""}`}
                      onMouseMove={() => setSel(i)}
                      onClick={() => accept(i)}
                    >
                      <span className="palette-line">{m.line}</span>
                      <span className="palette-text">
                        {m.text.slice(0, m.start)}
                        <b>{m.text.slice(m.start, m.end)}</b>
                        {m.text.slice(m.end)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette-foot">
          {mode === "text" && replaceMsg ? (
            <span className="palette-replaced">{replaceMsg}</span>
          ) : (
            mode === "text" &&
            matches.length > 0 && (
              <span>
                {matches.length}
                {truncated ? "+" : ""} match{matches.length === 1 ? "" : "es"} in {grouped.length} file
                {grouped.length === 1 ? "" : "s"}
                {truncated && " · results capped — refine the query"}
              </span>
            )
          )}
          <span className="palette-keys">↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}

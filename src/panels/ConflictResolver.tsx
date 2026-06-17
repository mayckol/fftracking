import { useEffect, useRef, useState } from "react";
import { Editor, loader } from "@monaco-editor/react";
import { api, WORKDIR } from "../lib/ipc";
import { basename, langOf } from "../lib/util";
import { defineAllThemes, monacoThemeId } from "../components/monacoTheme";
import { useUIPrefs } from "../lib/uiPrefs";
import { initPluginsForMonaco, usePlugins } from "../lib/plugins/registry";

type Segment =
  | { kind: "ctx"; text: string }
  | { kind: "conflict"; ours: string; theirs: string };

function parse(raw: string): Segment[] {
  const lines = raw.split("\n");
  const segs: Segment[] = [];
  let ctx: string[] = [];
  let i = 0;
  const flush = () => {
    if (ctx.length) {
      segs.push({ kind: "ctx", text: ctx.join("\n") });
      ctx = [];
    }
  };
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      flush();
      i++;
      const ours: string[] = [];
      while (i < lines.length && !lines[i].startsWith("=======") && !lines[i].startsWith("|||||||")) {
        ours.push(lines[i++]);
      }
      while (i < lines.length && !lines[i].startsWith("=======")) i++;
      i++; // past =======
      const theirs: string[] = [];
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        theirs.push(lines[i++]);
      }
      i++; // past >>>>>>>
      segs.push({ kind: "conflict", ours: ours.join("\n"), theirs: theirs.join("\n") });
    } else {
      ctx.push(lines[i++]);
    }
  }
  flush();
  return segs;
}

type Choice = "ours" | "theirs" | "both";

// 1-based line span in the resolved text that a conflict region produced.
type ResolvedRange = { start: number; end: number; choice: Choice };

const editKey = (idx: number, c: Choice) => `${idx}:${c}`;

// Text a conflict region contributes for a choice — a user edit of that
// region/option (from the hover popup) wins over the original git content.
function pickText(s: Extract<Segment, { kind: "conflict" }>, c: Choice, edits?: Record<string, string>, idx?: number): string {
  if (edits && idx != null) {
    const k = editKey(idx, c);
    if (k in edits) return edits[k];
  }
  if (c === "ours") return s.ours;
  if (c === "theirs") return s.theirs;
  return [s.ours, s.theirs].filter(Boolean).join("\n");
}

// Resolved text plus the line ranges each conflict contributed, so the editor
// can highlight where ours / theirs / both ended up.
function resolveWithRanges(
  segs: Segment[],
  choices: Record<number, Choice>,
  edits: Record<string, string>,
): { text: string; ranges: ResolvedRange[] } {
  const parts: string[] = [];
  const ranges: ResolvedRange[] = [];
  let line = 1;
  segs.forEach((s, i) => {
    let str: string;
    let choice: Choice | null = null;
    if (s.kind === "ctx") {
      str = s.text;
    } else {
      choice = choices[i] ?? "ours";
      str = pickText(s, choice, edits, i);
    }
    const count = str.length === 0 ? 1 : str.split("\n").length;
    if (choice) ranges.push({ start: line, end: line + count - 1, choice });
    parts.push(str);
    line += count;
  });
  return { text: parts.join("\n"), ranges };
}

interface Props {
  repoPath: string;
  path: string;
  toast: (msg: string, error?: boolean) => void;
  onResolved: () => void;
}

export default function ConflictResolver({ repoPath, path, toast, onResolved }: Props) {
  const prefs = useUIPrefs();
  usePlugins();
  const [segs, setSegs] = useState<Segment[]>([]);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [text, setText] = useState("");
  const [ranges, setRanges] = useState<ResolvedRange[]>([]);
  const [colored, setColored] = useState<Record<number, { ours: string; theirs: string }>>({});
  // Floating, editable preview shown while hovering an Accept/Keep button.
  const [hover, setHover] = useState<{ idx: number; opt: Choice } | null>(null);
  // Per-region/option overrides typed into the hover popup. Key = `${idx}:${opt}`.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const closeTimer = useRef<number | undefined>(undefined);

  const openHover = (idx: number, opt: Choice) => {
    window.clearTimeout(closeTimer.current);
    setHover({ idx, opt });
  };
  const scheduleCloseHover = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(null), 180);
  };

  function setEdit(idx: number, opt: Choice, val: string) {
    const next = { ...edits, [editKey(idx, opt)]: val };
    setEdits(next);
    const r = resolveWithRanges(segs, choices, next);
    setText(r.text);
    setRanges(r.ranges);
  }

  const editorRef = useRef<{ createDecorationsCollection: (d: unknown[]) => { set: (d: unknown[]) => void } } | null>(null);
  const monacoRef = useRef<{ Range: new (a: number, b: number, c: number, d: number) => unknown } | null>(null);
  const decoRef = useRef<{ set: (d: unknown[]) => void } | null>(null);
  const rangesRef = useRef<ResolvedRange[]>([]);
  rangesRef.current = ranges;

  const paintDecorations = (rs: ResolvedRange[]) => {
    const ed = editorRef.current;
    const mo = monacoRef.current;
    if (!ed || !mo) return;
    const decos = rs.map((r) => ({
      range: new mo.Range(r.start, 1, r.end, 1),
      options: { isWholeLine: true, className: `merge-line-${r.choice}`, linesDecorationsClassName: `merge-gutter-${r.choice}` },
    }));
    if (decoRef.current) decoRef.current.set(decos);
    else decoRef.current = ed.createDecorationsCollection(decos);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const raw = (await api.gitFile(repoPath, WORKDIR, path)) ?? "";
      if (!alive) return;
      const parsed = parse(raw);
      const c: Record<number, Choice> = {};
      parsed.forEach((s, i) => {
        if (s.kind === "conflict") c[i] = "ours";
      });
      const r = resolveWithRanges(parsed, c, {});
      setSegs(parsed);
      setChoices(c);
      setText(r.text);
      setRanges(r.ranges);
    })();
    return () => {
      alive = false;
    };
  }, [repoPath, path]);

  // Syntax-highlight each ours/theirs region with Monaco's colorizer.
  useEffect(() => {
    let alive = true;
    loader.init().then((monaco) => {
      const lang = langOf(path);
      const jobs = segs.map(async (s, i) =>
        s.kind === "conflict"
          ? ([i, { ours: await monaco.editor.colorize(s.ours || " ", lang, {}), theirs: await monaco.editor.colorize(s.theirs || " ", lang, {}) }] as const)
          : null,
      );
      Promise.all(jobs).then((rs) => {
        if (!alive) return;
        const m: Record<number, { ours: string; theirs: string }> = {};
        rs.forEach((r) => r && (m[r[0]] = r[1]));
        setColored(m);
      });
    });
    return () => {
      alive = false;
    };
  }, [segs, path]);

  const conflictCount = segs.filter((s) => s.kind === "conflict").length;

  function choose(idx: number, opt: Choice) {
    const next = { ...choices, [idx]: opt };
    const r = resolveWithRanges(segs, next, edits);
    setChoices(next);
    setText(r.text);
    setRanges(r.ranges);
  }

  // Reapply highlights when a choice/edit rewrites the resolved text. Child
  // Editor effects (value set) run before this parent effect, so decorations
  // land on the fresh content. Manual typing in the resolved editor changes
  // `text` but not `ranges`; we deliberately don't repaint then — Monaco shifts
  // the existing sticky decorations to follow the edits.
  useEffect(() => {
    paintDecorations(ranges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges]);

  async function save() {
    try {
      await api.gitResolveConflict(repoPath, path, text);
      toast(`Resolved ${basename(path)}`);
      onResolved();
    } catch (e) {
      toast(String(e), true);
    }
  }

  let n = 0;
  return (
    <div className="col main">
      <div className="conflict-banner">
        ⚠ Merge conflict — {conflictCount} region(s) in <b style={{ marginLeft: 4 }}>{basename(path)}</b>
        <div className="diff-actions" style={{ marginLeft: "auto" }}>
          <button className="tbtn primary" onClick={save}>
            Mark resolved &amp; stage
          </button>
        </div>
      </div>
      <div className="pane">
        {segs.map((s, i) => {
          if (s.kind === "ctx") {
            const lines = s.text.split("\n");
            const head = lines.slice(0, 3);
            const more = lines.length - head.length;
            return (
              <div key={i}>
                {head.map((l, j) => (
                  <div className="ctx-line" key={j}>
                    {l || " "}
                  </div>
                ))}
                {more > 0 && <div className="ctx-line">… {more} more lines</div>}
              </div>
            );
          }
          const idx = i;
          const c = choices[idx];
          const col = colored[idx];
          return (
            <div className="hunk" key={i}>
              <div className="hunk-side ours">
                <div className="lbl">
                  ◀ Ours · region {++n} {c === "ours" && "✓"}
                </div>
                {col ? <pre dangerouslySetInnerHTML={{ __html: col.ours }} /> : <pre>{s.ours || "(empty)"}</pre>}
              </div>
              <div className="hunk-side theirs">
                <div className="lbl">Theirs ▶ {c === "theirs" && "✓"}</div>
                {col ? <pre dangerouslySetInnerHTML={{ __html: col.theirs }} /> : <pre>{s.theirs || "(empty)"}</pre>}
              </div>
              <div className="hunk-acts">
                {(["ours", "theirs", "both"] as Choice[]).map((opt) => (
                  <button
                    key={opt}
                    className={`tbtn${c === opt ? " primary" : ""}`}
                    onClick={() => choose(idx, opt)}
                    onMouseEnter={() => openHover(idx, opt)}
                    onMouseLeave={scheduleCloseHover}
                  >
                    {opt === "ours" ? "Accept ours" : opt === "theirs" ? "Accept theirs" : "Keep both"}
                    {editKey(idx, opt) in edits && <span className="cp-edited" title="Edited">●</span>}
                  </button>
                ))}
                {hover?.idx === idx && (
                  <div
                    className={`choice-preview ${hover.opt}`}
                    onMouseEnter={() => openHover(hover.idx, hover.opt)}
                    onMouseLeave={scheduleCloseHover}
                  >
                    <div className="cp-head">
                      {hover.opt === "ours" ? "Accept ours" : hover.opt === "theirs" ? "Accept theirs" : "Keep both"}
                      <span className="cp-arrow">→ result (editable)</span>
                      {c !== hover.opt && (
                        <button className="cp-apply" onClick={() => choose(idx, hover.opt)}>
                          Use this
                        </button>
                      )}
                    </div>
                    <textarea
                      className="cp-body"
                      spellCheck={false}
                      value={pickText(s, hover.opt, edits, idx)}
                      onChange={(e) => setEdit(idx, hover.opt, e.target.value)}
                      rows={Math.min(14, Math.max(2, pickText(s, hover.opt, edits, idx).split("\n").length))}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div className="section-title">Resolved result (editable)</div>
        <div className="resolved-editor">
          <Editor
            height="320px"
            theme={monacoThemeId(prefs.theme)}
            language={langOf(path)}
            value={text}
            beforeMount={(m) => {
              defineAllThemes(m);
              initPluginsForMonaco(m);
            }}
            onMount={(ed, m) => {
              editorRef.current = ed as never;
              monacoRef.current = m as never;
              decoRef.current = null;
              paintDecorations(rangesRef.current);
            }}
            onChange={(v) => setText(v ?? "")}
            options={{
              fontFamily: "JetBrains Mono",
              fontSize: 12.5,
              lineHeight: 19,
              minimap: { enabled: false },
              renderLineHighlight: "none",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
      </div>
    </div>
  );
}

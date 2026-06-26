import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Editor } from "@monaco-editor/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/ipc";
import ConfirmModal from "../components/ConfirmModal";
import { basename, langOf } from "../lib/util";
import { defineAllThemes, monacoThemeId } from "../components/monacoTheme";
import { useUIPrefs } from "../lib/uiPrefs";
import { initPluginsForMonaco, usePlugins } from "../lib/plugins/registry";
import type { MergeBlock } from "../lib/types";
import type { Decision, Side, Snapshot } from "./merge/types";
import {
  appendEligible,
  bandHeight,
  defaultLines,
  initDecision,
  isChange,
  isPending,
  isWholeSideAbsent,
  linesFor,
  modelLineCount,
  prefixStarts,
  reconcile,
  relevant,
  resClass,
  sideClass,
  sideLines,
} from "./merge/derive";
import Toolbar from "./merge/Toolbar";
import Headers from "./merge/Headers";
import Footer from "./merge/Footer";

interface Range3 {
  start: number;
  end: number;
}

const LH = 19;

const RULER: Record<string, string> = {
  ours: "#7c8cff",
  theirs: "#4cc4c0",
  conflict: "#ff8c42",
  both: "#3fb950",
  edited: "#e3b341",
};

// One targeted, undoable edit that replaces block `i`'s CURRENT span (start line +
// old line count) with `newLines`. Handles every 0-line case (insert into an empty
// region, delete a region to empty) so a deletion never reaches a neighbour's line
// and an empty document round-trips cleanly. Returns null for an empty→empty no-op.
function blockEditOp(model: any, mo: any, start: number, oldLen: number, newLines: string[]): any {
  const value = model.getValue();
  const N = value === "" ? 0 : model.getLineCount();
  const m = newLines.length;
  const joined = newLines.join("\n");
  if (oldLen === 0) {
    if (m === 0) return null;
    if (N === 0) return { range: new mo.Range(1, 1, 1, 1), text: joined, forceMoveMarkers: true };
    if (start <= N) return { range: new mo.Range(start, 1, start, 1), text: joined + "\n", forceMoveMarkers: true };
    const col = model.getLineMaxColumn(N);
    return { range: new mo.Range(N, col, N, col), text: "\n" + joined, forceMoveMarkers: true };
  }
  const end = start + oldLen - 1;
  if (m === 0) {
    if (start === 1 && end >= N) return { range: new mo.Range(1, 1, N, model.getLineMaxColumn(N)), text: "", forceMoveMarkers: true };
    if (end < N) return { range: new mo.Range(start, 1, end + 1, 1), text: "", forceMoveMarkers: true };
    const prevCol = model.getLineMaxColumn(start - 1);
    return { range: new mo.Range(start - 1, prevCol, end, model.getLineMaxColumn(end)), text: "", forceMoveMarkers: true };
  }
  return { range: new mo.Range(start, 1, end, model.getLineMaxColumn(end)), text: joined, forceMoveMarkers: true };
}

interface Props {
  repoPath: string;
  path: string;
  oursLabel: string;
  theirsLabel: string;
  toast: (msg: string, error?: boolean) => void;
  onResolved: () => void;
  onClose: () => void;
  /** Rendered as its own OS window: fill the frame, no overlay/portal/drag. */
  windowed?: boolean;
}

export default function MergeEditor({ repoPath, path, oursLabel, theirsLabel, toast, onResolved, onClose, windowed = false }: Props) {
  const prefs = useUIPrefs();
  usePlugins();
  const [blocks, setBlocks] = useState<MergeBlock[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [w, setW] = useState<[number, number, number]>([1, 1, 1]);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const lang = langOf(path);

  const oursRef = useRef<any>(null);
  const theirsRef = useRef<any>(null);
  const resRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decoRefs = useRef<{ ours?: any; theirs?: any; res?: any }>({});
  const syncing = useRef(false);
  const split0Ref = useRef<HTMLDivElement>(null);
  const split1Ref = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const zoneIds = useRef<{ ours: string[]; theirs: string[]; result: string[] }>({ ours: [], theirs: [], result: [] });

  // Synchronous mirrors — the Monaco content callback runs before React state
  // settles, so it needs the live values.
  const blocksRef = useRef<MergeBlock[]>([]);
  const decisionsRef = useRef<Decision[]>([]);
  // Positional truth: one slot per block (change AND unchanged). Σ lineCount equals
  // the result model's line count; prefix sums give every block's live span.
  const lineCountRef = useRef<number[]>([]);
  const closingRef = useRef(false);
  // True across our own executeEdits, so the content callback knows the metadata was
  // already set by the action (vs. a manual keystroke).
  const programmatic = useRef(false);
  // alternativeVersionId → resolution snapshot, so undo/redo restores per-block
  // decisions in lockstep with Monaco's native text undo. editSeq co-keys against
  // altId reuse (identical text recurring with different decisions).
  const snapByAlt = useRef<Map<number, Snapshot>>(new Map());
  const editSeqRef = useRef(0);

  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const bumpTick = () => setTick((t) => t + 1);

  const setDec = (next: Decision[]) => {
    decisionsRef.current = next;
    setDecisions(next);
  };

  // ── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bs = await api.gitMergeBlocks(repoPath, path);
        if (!alive) return;
        blocksRef.current = bs;
        lineCountRef.current = bs.map((b) => defaultLines(b).length);
        const ds = bs.map(initDecision);
        decisionsRef.current = ds;
        setBlocks(bs);
        setDecisions(ds);
      } catch (e) {
        if (!alive) return;
        // No conflict to load (stale row, aborted merge, binary file): surface it and
        // close, instead of mounting an empty editor that would overwrite the file
        // with "" on close.
        toast(String(e), true);
        closingRef.current = true;
        onClose();
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoPath, path]);

  const changeIdx = useMemo(() => blocks.map((b, i) => (isChange(b) ? i : -1)).filter((i) => i >= 0), [blocks]);
  const oursText = useMemo(() => blocks.flatMap((b) => sideLines(b, "ours")).join("\n"), [blocks]);
  const theirsText = useMemo(() => blocks.flatMap((b) => sideLines(b, "theirs")).join("\n"), [blocks]);
  const initialText = useMemo(() => blocks.flatMap(defaultLines).join("\n"), [blocks]);

  // Static per-block line ranges in the read-only side panes.
  const sideRanges = useMemo(() => {
    const build = (side: Side) => {
      const out: Range3[] = [];
      let cur = 1;
      blocks.forEach((b) => {
        const n = sideLines(b, side).length;
        out.push({ start: cur, end: cur + n - 1 });
        cur += n;
      });
      return out;
    };
    return { ours: build("ours"), theirs: build("theirs") };
  }, [blocks]);

  const changeCount = useMemo(() => blocks.filter(isChange).length, [blocks]);
  const remaining = useMemo(
    () => blocks.reduce((n, b, i) => n + (b.kind === "conflict" && decisions[i]?.kind === "default" ? 1 : 0), 0),
    [blocks, decisions],
  );
  const unprocessed = useMemo(
    () => blocks.reduce((n, b, i) => n + (isChange(b) && b.kind !== "conflict" && decisions[i]?.kind === "default" ? 1 : 0), 0),
    [blocks, decisions],
  );

  // ── snapshots / undo ────────────────────────────────────────────────────────
  const snapshot = (altId: number) => {
    editSeqRef.current += 1;
    snapByAlt.current.set(altId, {
      decisions: decisionsRef.current.slice(),
      lineCounts: lineCountRef.current.slice(),
      editSeq: editSeqRef.current,
    });
    const m = snapByAlt.current;
    while (m.size > 600) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };

  // Self-heal: when manual reconciliation leaves Σ lineCount out of step with the
  // model, rebuild lineCount from the known (non-manual) block lengths and put the
  // remainder on the first manual block — a recoverable event, not silent corruption.
  const rederive = (model: any) => {
    const N = modelLineCount(model.getValue(), model.getLineCount());
    const lc = blocksRef.current.map((b, i) => (decisionsRef.current[i].kind === "manual" ? -1 : linesFor(b, decisionsRef.current[i]).length));
    const knownSum = lc.reduce((a, v) => a + (v > 0 ? v : 0), 0);
    const manualIdxs = lc.map((v, i) => (v < 0 ? i : -1)).filter((i) => i >= 0);
    lc.forEach((v, i) => { if (v < 0) lc[i] = 0; });
    if (manualIdxs.length) lc[manualIdxs[0]] = Math.max(0, N - knownSum);
    lineCountRef.current = lc;
  };

  const onResultContent = useCallback((e: any) => {
    const model = resRef.current?.getModel();
    if (!model) return;
    const altId = model.getAlternativeVersionId();
    const known = snapByAlt.current.get(altId);
    if (known) {
      // Undo/redo landed on a state we've seen — restore its metadata in lockstep.
      lineCountRef.current = known.lineCounts.slice();
      editSeqRef.current = known.editSeq;
      setDec(known.decisions.slice());
      bump();
    } else if (programmatic.current) {
      programmatic.current = false;
      snapshot(altId);
    } else {
      // Manual keystroke: reconcile line counts, mark touched change blocks manual.
      const { lineCount, touched } = reconcile(lineCountRef.current, blocksRef.current, e?.changes ?? []);
      lineCountRef.current = lineCount;
      if (touched.length) {
        const next = decisionsRef.current.slice();
        for (const i of touched) next[i] = { kind: "manual" };
        decisionsRef.current = next;
        setDecisions(next);
      }
      const sum = lineCountRef.current.reduce((a, b) => a + b, 0);
      if (sum !== modelLineCount(model.getValue(), model.getLineCount())) rederive(model);
      snapshot(altId);
      bump();
    }
  }, []);

  // ── result mutations (all through Monaco so undo covers them) ────────────────
  const setBlock = (i: number, dec: Decision) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    const b = blocksRef.current[i];
    if (!ed || !model || !mo || !b) return;
    const lc = lineCountRef.current;
    const starts = prefixStarts(lc);
    const newLines = linesFor(b, dec);
    const op = blockEditOp(model, mo, starts[i], lc[i], newLines);
    lc[i] = newLines.length;
    const nd = decisionsRef.current.slice();
    nd[i] = dec;
    decisionsRef.current = nd;
    ed.pushUndoStop();
    if (op) {
      programmatic.current = true;
      ed.executeEdits("merge", [op]);
      ed.pushUndoStop();
    }
    setDecisions(nd);
    bump();
  };

  const apply = (i: number, side: Side) => {
    const b = blocksRef.current[i];
    if (!b) return;
    const dec: Decision = appendEligible(b, side, decisionsRef.current[i]) ? { kind: "side", side, append: true } : { kind: "side", side };
    setBlock(i, dec);
  };

  const ignore = (i: number) => setBlock(i, { kind: "skip" });

  const acceptAll = (side: Side) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    if (!ed || !model || !mo) return;
    const lc = lineCountRef.current;
    const starts = prefixStarts(lc);
    const blocks0 = blocksRef.current;
    // Skip manual blocks so Accept-all never clobbers hand-typed content.
    const targets = blocks0.map((_b, i) => i).filter((i) => relevant(blocks0[i], side) && decisionsRef.current[i].kind !== "manual");
    if (!targets.length) return;
    // Bottom-up so earlier ranges stay valid as Monaco applies the batch; all ops
    // are built against the same pre-edit model.
    const ops = targets
      .slice()
      .sort((a, b) => b - a)
      .map((i) => {
        const lines = linesFor(blocks0[i], { kind: "side", side });
        return { i, op: blockEditOp(model, mo, starts[i], lc[i], lines), m: lines.length };
      });
    const nd = decisionsRef.current.slice();
    ops.forEach(({ i, m }) => {
      lc[i] = m;
      nd[i] = { kind: "side", side };
    });
    decisionsRef.current = nd;
    const edits = ops.map((o) => o.op).filter(Boolean);
    ed.pushUndoStop();
    if (edits.length) {
      programmatic.current = true;
      ed.executeEdits("merge", edits);
      ed.pushUndoStop();
    }
    setDecisions(nd);
    bump();
  };

  // Toolbar "Apply non-conflicting changes" (≫ Left / All / ≪ Right) and the wand.
  // Marks every NON-conflicting one-sided change resolved — its content is already
  // the default side, so no edit is needed. `side` limits to that side's changes;
  // omit for both. True conflicts are left untouched (unlike the footer's Accept).
  const resolveNonConflicting = (side?: Side) => {
    const next = decisionsRef.current.slice();
    let changed = false;
    blocksRef.current.forEach((b, i) => {
      if (!isChange(b) || b.kind === "conflict" || next[i].kind !== "default") return;
      const bSide: Side = b.kind === "theirs" ? "theirs" : "ours"; // 'both' → ours
      if (side && bSide !== side) return;
      next[i] = { kind: "side", side: bSide };
      changed = true;
    });
    if (!changed) {
      toast("No non-conflicting changes to apply");
      return;
    }
    setDec(next);
    bump();
  };

  // ── alignment spacers + band decorations ─────────────────────────────────────
  const applyZones = useCallback(() => {
    const eds: Record<"ours" | "theirs" | "result", any> = { ours: oursRef.current, theirs: theirsRef.current, result: resRef.current };
    const lc = lineCountRef.current;
    (["ours", "theirs", "result"] as const).forEach((which) => {
      const ed = eds[which];
      if (!ed) return;
      let line = 0;
      const plan: { afterLineNumber: number; heightInLines: number; cls: string | null }[] = [];
      blocksRef.current.forEach((b, i) => {
        const cOurs = sideLines(b, "ours").length;
        const cTheirs = sideLines(b, "theirs").length;
        const cRes = lc[i] ?? 0;
        const h = bandHeight(b, cRes);
        const cnt = which === "ours" ? cOurs : which === "theirs" ? cTheirs : cRes;
        line += cnt;
        const cls = which === "result" ? resClass(b, decisionsRef.current[i]) : sideClass(b, which, decisionsRef.current[i]);
        if (h - cnt > 0) plan.push({ afterLineNumber: line, heightInLines: h - cnt, cls });
      });
      ed.changeViewZones((acc: any) => {
        zoneIds.current[which].forEach((id) => acc.removeZone(id));
        zoneIds.current[which] = plan.map((z) => {
          const dom = document.createElement("div");
          dom.className = `mrg-spacer${z.cls ? ` sp-${z.cls}` : ""}`;
          return acc.addZone({ afterLineNumber: z.afterLineNumber, heightInLines: z.heightInLines, domNode: dom });
        });
      });
    });
  }, []);

  const paint = useCallback(() => {
    const mo = monacoRef.current;
    if (!mo) return;
    const R = (a: number, b: number) => new mo.Range(a, 1, b, 1);
    const sideDecos = (side: Side) =>
      blocksRef.current
        .map((b, i) => ({ i, cls: sideClass(b, side, decisionsRef.current[i]), r: side === "ours" ? sideRanges.ours[i] : sideRanges.theirs[i] }))
        .filter((x) => x.cls && x.r && x.r.end >= x.r.start)
        .map((x) => ({ range: R(x.r!.start, x.r!.end), options: { isWholeLine: true, className: `mrg-line-${x.cls}`, marginClassName: `mrg-line-${x.cls}` } }));
    if (oursRef.current) {
      decoRefs.current.ours = decoRefs.current.ours ?? oursRef.current.createDecorationsCollection([]);
      decoRefs.current.ours.set(sideDecos("ours"));
    }
    if (theirsRef.current) {
      decoRefs.current.theirs = decoRefs.current.theirs ?? theirsRef.current.createDecorationsCollection([]);
      decoRefs.current.theirs.set(sideDecos("theirs"));
    }
    if (resRef.current) {
      const lc = lineCountRef.current;
      const starts = prefixStarts(lc);
      const decos = blocksRef.current
        .map((b, i) => ({ b, i, cls: resClass(b, decisionsRef.current[i]) }))
        .filter((x) => isChange(x.b) && x.cls && lc[x.i] > 0)
        .map((x) => ({
          range: R(starts[x.i], starts[x.i] + lc[x.i] - 1),
          options: {
            isWholeLine: true,
            className: `mrg-res-${x.cls}`,
            marginClassName: `mrg-res-${x.cls}`,
            overviewRuler: { color: RULER[x.cls!] ?? RULER.ours, position: mo.editor.OverviewRulerLane.Full },
          },
        }));
      decoRefs.current.res = decoRefs.current.res ?? resRef.current.createDecorationsCollection([]);
      decoRefs.current.res.set(decos);
    }
  }, [sideRanges]);

  useEffect(() => {
    paint();
    applyZones();
    bumpTick();
  }, [paint, applyZones, version, ready, w]);

  useEffect(() => {
    const onResize = () => bumpTick();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── connectors + in-gutter action pills ──────────────────────────────────────
  const lineStarts = (kind: "ours" | "theirs" | "result"): number[] => {
    const arr = [1];
    const lc = lineCountRef.current;
    blocksRef.current.forEach((b, i) => {
      const len = kind === "result" ? lc[i] ?? 0 : sideLines(b, kind).length;
      arr.push(arr[arr.length - 1] + len);
    });
    return arr;
  };

  const spanTop = (ed: any, line: number, baseTop: number): number => {
    const domTop = ed.getDomNode()?.getBoundingClientRect().top ?? 0;
    return domTop + ed.getTopForLineNumber(line) - ed.getScrollTop() - baseTop;
  };

  const renderGutter = (g: 0 | 1) => {
    void tick;
    void version;
    const leftEd = g === 0 ? oursRef.current : resRef.current;
    const rightEd = g === 0 ? resRef.current : theirsRef.current;
    const leftKind = g === 0 ? "ours" : "result";
    const rightKind = g === 0 ? "result" : "theirs";
    const split = (g === 0 ? split0Ref : split1Ref).current;
    if (!leftEd || !rightEd || !resRef.current || !split) return null;
    const rect = split.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const ls = lineStarts(leftKind as any);
    const rs = lineStarts(rightKind as any);
    const rres = lineStarts("result");
    const side: Side = g === 0 ? "ours" : "theirs";
    const editorTop = (resRef.current.getDomNode()?.getBoundingClientRect().top ?? rect.top) - rect.top;

    const shapes: { i: number; cls: string; points: string }[] = [];
    const rows: any[] = [];
    blocksRef.current.forEach((b, i) => {
      if (!isChange(b)) return;
      const cls = resClass(b, decisionsRef.current[i]);
      const lt = spanTop(leftEd, ls[i], rect.top);
      const lb = spanTop(leftEd, ls[i + 1], rect.top);
      const rt = spanTop(rightEd, rs[i], rect.top);
      const rb = spanTop(rightEd, rs[i + 1], rect.top);
      if (cls && Math.max(lb, rb) >= editorTop && Math.min(lt, rt) <= H) {
        shapes.push({ i, cls, points: `0,${lt} ${W},${rt} ${W},${rb} 0,${lb}` });
      }
      // Action pill — aligned to the result-pane row, shown while the change is
      // still actionable for this side.
      const d = decisionsRef.current[i];
      const actionable = relevant(b, side) && (isPending(d) || appendEligible(b, side, d));
      if (actionable) {
        const top = spanTop(resRef.current, rres[i], rect.top);
        if (top >= editorTop - 2 && top <= H - 8) rows.push({ i, top, append: appendEligible(b, side, d) });
      }
    });

    return (
      <>
        <svg className="mrg-conn" width={W} height={H} preserveAspectRatio="none" style={{ clipPath: `inset(${Math.max(0, editorTop)}px 0 0 0)` }}>
          {shapes.map((p) => (
            <polygon key={p.i} points={p.points} className={`mc-${p.cls}`} />
          ))}
        </svg>
        <div className="mrg-acts">
          {rows.map((r) => {
            const accept = (
              <button
                key="a"
                className={`mrg-act accept ${r.append ? "add" : side}`}
                title={r.append ? "Append this side below the other (keep both)" : g === 0 ? "Accept Left into Result" : "Accept Right into Result"}
                onClick={() => apply(r.i, side)}
              >
                {r.append ? "↓" : g === 0 ? "≫" : "≪"}
              </button>
            );
            const reject = (
              <button key="x" className="mrg-act reject" title="Reject / skip this change" onClick={() => ignore(r.i)}>
                ✕
              </button>
            );
            return (
              <div key={r.i} className="mrg-act-row" style={{ top: r.top }}>
                {g === 0 ? [accept, reject] : [accept, reject]}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  // ── scroll sync ──────────────────────────────────────────────────────────────
  const lockScroll = (src: any) => {
    src.onDidScrollChange(() => {
      bumpTick();
      if (syncing.current) return;
      syncing.current = true;
      const top = src.getScrollTop();
      const left = src.getScrollLeft();
      for (const ed of [oursRef.current, theirsRef.current, resRef.current]) {
        if (!ed || ed === src) continue;
        ed.setScrollTop(top);
        ed.setScrollLeft(left);
      }
      syncing.current = false;
    });
  };

  useEffect(() => {
    const cont = panesRef.current;
    if (!cont) return;
    const onWheel = (e: WheelEvent) => {
      const eds = [oursRef.current, theirsRef.current, resRef.current].filter(Boolean);
      if (eds.length < 2) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LH : e.deltaMode === 2 ? eds[0].getLayoutInfo().height : 1;
      const dY = e.deltaY * unit;
      const dX = e.deltaX * unit;
      syncing.current = true;
      // Monaco clamps each editor to its own extent, so a taller/wider pane keeps
      // scrolling after the shorter ones bottom out — "scroll only the greater side".
      for (const ed of eds) {
        if (dY) ed.setScrollTop(Math.max(0, ed.getScrollTop() + dY));
        if (dX) ed.setScrollLeft(Math.max(0, ed.getScrollLeft() + dX));
      }
      syncing.current = false;
      bumpTick();
    };
    cont.addEventListener("wheel", onWheel, { passive: false });
    return () => cont.removeEventListener("wheel", onWheel);
  }, [ready]);

  // ── mounts ───────────────────────────────────────────────────────────────────
  const mountSide = (which: Side) => (ed: any, mo: any) => {
    monacoRef.current = mo;
    if (which === "ours") oursRef.current = ed;
    else theirsRef.current = ed;
    lockScroll(ed);
    setReady((r) => r + 1);
  };

  const mountResult = (ed: any, mo: any) => {
    monacoRef.current = mo;
    resRef.current = ed;
    // NOTE: three plain editors, NOT Monaco's createDiffEditor — a 2-way diff editor
    // can't host a single shared editable center pane (one editor belongs to one diff
    // editor) nor compute the 3-way max-band alignment. Don't "simplify" to it.
    const model = ed.getModel();
    snapByAlt.current.set(model.getAlternativeVersionId(), {
      decisions: decisionsRef.current.slice(),
      lineCounts: lineCountRef.current.slice(),
      editSeq: editSeqRef.current,
    });
    model.onDidChangeContent(onResultContent);
    lockScroll(ed);
    setReady((r) => r + 1);
  };

  // ── navigation ───────────────────────────────────────────────────────────────
  const [cur, setCur] = useState(-1);
  const navDiff = useCallback(
    (dir: 1 | -1) => {
      if (!changeIdx.length) return;
      const p = changeIdx.indexOf(cur);
      const nextIdx = p < 0 ? (dir > 0 ? changeIdx[0] : changeIdx[changeIdx.length - 1]) : changeIdx[(p + dir + changeIdx.length) % changeIdx.length];
      setCur(nextIdx);
      const line = prefixStarts(lineCountRef.current)[nextIdx];
      if (resRef.current) {
        resRef.current.revealLineInCenter(Math.max(line, 1));
        resRef.current.setPosition({ lineNumber: Math.max(line, 1), column: 1 });
      }
    },
    [changeIdx, cur],
  );

  const undo = () => resRef.current?.trigger("merge", "undo", null);
  const redo = () => resRef.current?.trigger("merge", "redo", null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        attemptCloseRef.current();
        return;
      }
      if (e.key === "F7") {
        e.preventDefault();
        navDiff(e.shiftKey ? -1 : 1);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        if (resRef.current?.hasTextFocus()) return;
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (k === "y") {
        if (resRef.current?.hasTextFocus()) return;
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navDiff]);

  // ── persist / close ──────────────────────────────────────────────────────────
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);

  async function doResolve() {
    const model = resRef.current?.getModel();
    if (!model || changeCount === 0) {
      closingRef.current = true;
      onClose();
      return;
    }
    try {
      const value = model.getValue();
      // Modify/delete: the result is empty and one side deleted the file. Route through
      // accept_side so the backend removes + unstages it, instead of writing "" (which
      // would leave the file present-but-empty).
      if (value === "" && (isWholeSideAbsent(blocksRef.current, "theirs") || isWholeSideAbsent(blocksRef.current, "ours"))) {
        const side: Side = isWholeSideAbsent(blocksRef.current, "theirs") ? "theirs" : "ours";
        await api.gitAcceptSide(repoPath, path, side);
      } else {
        await api.gitResolveConflict(repoPath, path, value);
      }
      closingRef.current = true;
      onResolved();
    } catch (e) {
      toast(String(e), true);
    }
  }

  const attemptClose = () => {
    if (remaining > 0) setConfirmClose(true);
    else doResolve();
  };
  const attemptCloseRef = useRef(attemptClose);
  attemptCloseRef.current = attemptClose;

  const discardAndClose = () => {
    closingRef.current = true;
    setConfirmClose(false);
    onClose();
  };
  const cancel = () => {
    if (remaining > 0) setConfirmClose(true);
    else discardAndClose();
  };
  const applyMerge = () => {
    if (remaining > 0) setConfirmApply(true);
    else doResolve();
  };

  const announced = useRef(false);
  useEffect(() => {
    if (remaining === 0 && changeCount > 0 && blocks.length > 0 && !announced.current) {
      announced.current = true;
      toast(`All conflicts resolved in ${basename(path)} — click Apply`);
    }
  }, [remaining, changeCount, blocks.length, path]);

  useEffect(() => {
    if (!windowed) return;
    const win = getCurrentWindow();
    const un = win.onCloseRequested((e) => {
      if (closingRef.current) return;
      e.preventDefault();
      attemptCloseRef.current();
    });
    return () => {
      un.then((f) => f());
    };
  }, [windowed]);

  // ── drag (splitters + floating modal) ────────────────────────────────────────
  const dragSplit = (i: 0 | 1) => (e: React.MouseEvent) => {
    e.preventDefault();
    const cont = panesRef.current;
    if (!cont) return;
    const total = cont.clientWidth;
    const startX = e.clientX;
    const start = [...w] as [number, number, number];
    const sum = start[0] + start[1] + start[2];
    const onMove = (ev: MouseEvent) => {
      const dFrac = ((ev.clientX - startX) / total) * sum;
      const a = start[i] + dFrac;
      const b = start[i + 1] - dFrac;
      if (a < 0.3 || b < 0.3) return;
      const next = [...start] as [number, number, number];
      next[i] = a;
      next[i + 1] = b;
      setW(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const dragModal = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = pos ?? { x: 0, y: 0 };
    const onMove = (ev: MouseEvent) => setPos({ x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) });
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const sideOptions = {
    fontFamily: "JetBrains Mono",
    fontSize: 12.5,
    lineHeight: LH,
    minimap: { enabled: false },
    renderLineHighlight: "none" as const,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    padding: { top: 8, bottom: 8 },
    folding: collapsed,
  };


  const shell = (
    <div
      className={`mrg${windowed ? " windowed" : ""}`}
      style={!windowed && pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
    >
      <div onMouseDown={windowed ? undefined : dragModal}>
        <Toolbar
          oursLabel={oursLabel}
          theirsLabel={theirsLabel}
          changeCount={changeCount}
          remaining={remaining}
          collapsed={collapsed}
          onPrev={() => navDiff(-1)}
          onNext={() => navDiff(1)}
          onApplyAll={(side) => resolveNonConflicting(side)}
          onApplyAllBoth={() => resolveNonConflicting()}
          onWand={() => resolveNonConflicting()}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
      </div>

      <Headers oursLabel={oursLabel} theirsLabel={theirsLabel} relPath={path} path={path} w={w} />

      {blocks.length === 0 ? (
        <div className="mrg-panes">
          <div className="dbg-hint">Loading…</div>
        </div>
      ) : (
        <div className="mrg-panes" ref={panesRef}>
          <div className="mrg-pane" style={{ flexGrow: w[0] }}>
            <Editor
              className="editor-wrap"
              theme={monacoThemeId(prefs.theme)}
              language={lang}
              value={oursText}
              beforeMount={(m) => {
                defineAllThemes(m);
                initPluginsForMonaco(m);
              }}
              onMount={mountSide("ours")}
              options={{ ...sideOptions, readOnly: true }}
            />
          </div>

          <div className="mrg-gutter" ref={split0Ref} onMouseDown={dragSplit(0)}>
            {renderGutter(0)}
          </div>

          <div className="mrg-pane center" style={{ flexGrow: w[1] }}>
            <Editor
              className="editor-wrap"
              theme={monacoThemeId(prefs.theme)}
              language={lang}
              defaultValue={initialText}
              beforeMount={(m) => {
                defineAllThemes(m);
                initPluginsForMonaco(m);
              }}
              onMount={mountResult}
              options={{ ...sideOptions, readOnly: false, overviewRulerLanes: 3, overviewRulerBorder: false }}
            />
          </div>

          <div className="mrg-gutter" ref={split1Ref} onMouseDown={dragSplit(1)}>
            {renderGutter(1)}
          </div>

          <div className="mrg-pane" style={{ flexGrow: w[2] }}>
            <Editor
              className="editor-wrap"
              theme={monacoThemeId(prefs.theme)}
              language={lang}
              value={theirsText}
              beforeMount={(m) => {
                defineAllThemes(m);
                initPluginsForMonaco(m);
              }}
              onMount={mountSide("theirs")}
              options={{ ...sideOptions, readOnly: true }}
            />
          </div>
        </div>
      )}

      <Footer busy={blocks.length === 0} changeCount={changeCount} onAcceptAll={acceptAll} onCancel={cancel} onApply={applyMerge} />

      {confirmClose && (
        <ConfirmModal
          title="Unresolved conflicts"
          danger
          message={
            <>
              {remaining} conflict{remaining === 1 ? "" : "s"} in <b>{basename(path)}</b> {remaining === 1 ? "is" : "are"} still unresolved. Close
              without applying? Your resolutions won’t be saved.
            </>
          }
          confirmLabel="Close anyway"
          onConfirm={discardAndClose}
          onCancel={() => setConfirmClose(false)}
        />
      )}
      {confirmApply && (
        <ConfirmModal
          title="Apply Changes"
          confirmLabel="Apply Changes and Mark Resolved"
          cancelLabel="Continue Merge"
          message={
            <>
              {unprocessed > 0 ? (
                <>
                  There are {unprocessed} change{unprocessed === 1 ? "" : "s"} and {remaining} conflict{remaining === 1 ? "" : "s"} left unprocessed.{" "}
                </>
              ) : (
                <>
                  {remaining === 1 ? "There is" : "There are"} {remaining} conflict{remaining === 1 ? "" : "s"} left unprocessed.{" "}
                </>
              )}
              Save changes and mark {remaining === 1 ? "the conflict" : "them"} resolved anyway?
            </>
          }
          onConfirm={() => {
            setConfirmApply(false);
            doResolve();
          }}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  );

  if (windowed) return <div className="mrg-window">{shell}</div>;
  return createPortal(
    <div className="mrg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {shell}
    </div>,
    document.body,
  );
}

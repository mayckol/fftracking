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

type Side = "ours" | "theirs";
// Per-change resolution. `pending` = not yet reviewed (shows band + buttons);
// the rest hide the band/buttons. `edited` = user typed inside the region.
type St = "pending" | "ours" | "theirs" | "both" | "base" | "edited";

interface Range3 {
  start: number;
  end: number;
}

const isChange = (b: MergeBlock) => b.kind !== "unchanged";

function sideLines(b: MergeBlock, side: Side): string[] {
  if (b.kind === "unchanged") return b.base;
  return side === "ours" ? b.ours : b.theirs;
}

// The result content a block contributes before any user action: every change is
// auto-applied (conflicts default to ours) — exactly git's pre-merge buffer minus
// the markers. Resolving only rewrites the conflicting regions.
function initResult(b: MergeBlock): string[] {
  switch (b.kind) {
    case "unchanged":
      return b.base;
    case "ours":
    case "both":
    case "conflict":
      return b.ours;
    case "theirs":
      return b.theirs;
  }
}

function initStatus(b: MergeBlock): St {
  return isChange(b) ? "pending" : "base";
}

// A change is relevant to a side pane only if that side actually changed it.
function relevant(b: MergeBlock, side: Side): boolean {
  if (!isChange(b)) return false;
  return side === "ours" ? b.kind !== "theirs" : b.kind !== "ours";
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
  const [status, setStatus] = useState<St[]>([]);
  const [w, setW] = useState<[number, number, number]>([1, 1, 1]);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const lang = langOf(path);

  const oursRef = useRef<any>(null);
  const theirsRef = useRef<any>(null);
  const resRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decoRefs = useRef<{ ours?: any; theirs?: any; res?: any }>({});
  const syncing = useRef(false);
  // The two splitter gutters that host the JetBrains-style change connectors.
  const split0Ref = useRef<HTMLDivElement>(null);
  const split1Ref = useRef<HTMLDivElement>(null);

  // Synchronous mirror of `status` (React state is async; the Monaco content
  // callback needs the live value) + the change-region decoration ids on the
  // result model, in change-block order.
  const statusRef = useRef<St[]>([]);
  const resDecoIds = useRef<string[]>([]);
  // Parallel to resDecoIds: whether each change region currently contributes zero
  // result lines, so it is tracked as a collapsed insertion anchor. A 0-line span
  // can't be a real decoration range and would otherwise drift onto — and let edits
  // clobber — the next block's first line.
  const resEmpty = useRef<boolean[]>([]);
  // Set just before we close the window ourselves, so the onCloseRequested guard
  // lets the close through instead of re-prompting.
  const closingRef = useRef(false);
  // alternativeVersionId → status snapshot. Monaco reuses the same id when undo/
  // redo lands back on a content state, so this restores per-change status in
  // lockstep with the editor's native undo — one unified history.
  const statusByAlt = useRef<Map<number, St[]>>(new Map());
  // True for the span of our own executeEdits, so the content callback knows the
  // status was already set by the action (vs. a manual keystroke).
  const programmatic = useRef(false);

  const setStat = (next: St[]) => {
    statusRef.current = next;
    setStatus(next);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bs = await api.gitMergeBlocks(repoPath, path);
        if (!alive) return;
        setBlocks(bs);
        setStat(bs.map(initStatus));
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
  const initialText = useMemo(() => blocks.flatMap(initResult).join("\n"), [blocks]);

  // Static per-block line ranges in the (read-only) side panes.
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

  // Current result line-range of a change block, read live from its decoration so
  // it stays correct across manual edits.
  const resRange = useCallback((blockIdx: number): Range3 | null => {
    const model = resRef.current?.getModel();
    if (!model) return null;
    const pos = changeIdx.indexOf(blockIdx);
    const id = resDecoIds.current[pos];
    if (!id) return null;
    const r = model.getDecorationRange(id);
    return r ? { start: r.startLineNumber, end: r.endLineNumber } : null;
  }, [changeIdx]);

  const remaining = useMemo(
    () => blocks.reduce((n, b, i) => n + (b.kind === "conflict" && status[i] === "pending" ? 1 : 0), 0),
    [blocks, status],
  );
  const changeCount = useMemo(() => blocks.filter(isChange).length, [blocks]);
  // Non-conflict changes not yet explicitly acted on (auto-applied to a default
  // side); shown in the Apply-anyway confirmation alongside `remaining`.
  const unprocessed = useMemo(
    () => blocks.reduce((n, b, i) => n + (isChange(b) && b.kind !== "conflict" && status[i] === "pending" ? 1 : 0), 0),
    [blocks, status],
  );

  // Bumped on scroll/layout so the overlay buttons re-position; `ready` ticks as
  // editors mount so paint/zones re-run once instances exist.
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [ready, setReady] = useState(0);

  const appendBelow = useCallback(
    (blockIdx: number, which: Side): boolean => {
      const b = blocks[blockIdx];
      if (!b || b.kind !== "conflict") return false;
      const st = statusRef.current[blockIdx];
      const other: Side = which === "ours" ? "theirs" : "ours";
      // One side already taken, this side not yet — clicking keeps both.
      return st === other;
    },
    [blocks],
  );

  // ---- result mutations (all routed through Monaco so undo covers them) ----

  const changePos = (blockIdx: number) => changeIdx.indexOf(blockIdx);

  // Live decoration range of a change block (a collapsed anchor for a 0-line
  // region); null before the result editor mounts.
  const decoRange = (blockIdx: number): any => {
    const model = resRef.current?.getModel();
    const id = resDecoIds.current[changePos(blockIdx)];
    if (!model || !id) return null;
    return model.getDecorationRange(id);
  };

  const isEmptyRegion = (blockIdx: number) => !!resEmpty.current[changePos(blockIdx)];

  // (Re)seed one change block's tracking decoration. A zero-line region is anchored
  // as a collapsed marker at the end of the previous line (or doc start) so it never
  // overlaps — and so is never mistaken for — the following block's first line.
  const setBlockRegion = (blockIdx: number, start: number, len: number) => {
    const model = resRef.current?.getModel();
    const mo = monacoRef.current;
    if (!model || !mo) return;
    const pos = changePos(blockIdx);
    const oldId = resDecoIds.current[pos];
    let range: any;
    if (len === 0) {
      if (start > 1) {
        const p = Math.min(start - 1, model.getLineCount());
        const col = model.getLineMaxColumn(p);
        range = new mo.Range(p, col, p, col);
      } else {
        range = new mo.Range(1, 1, 1, 1);
      }
      resEmpty.current[pos] = true;
    } else {
      range = new mo.Range(start, 1, start + len - 1, 1);
      resEmpty.current[pos] = false;
    }
    const [newId] = model.deltaDecorations(oldId ? [oldId] : [], [
      { range, options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } },
    ]);
    resDecoIds.current[pos] = newId;
  };

  // Replace a change block's current result region with `newLines`, handling the
  // zero-line cases (empty source = insert at the anchor; empty target = delete the
  // span) so a deletion never reaches into the neighbouring block's lines.
  const editResult = (blockIdx: number, newLines: string[]) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    if (!ed || !model || !mo) return;
    const pos = changePos(blockIdx);
    const a = model.getDecorationRange(resDecoIds.current[pos]);
    if (!a) return;
    programmatic.current = true;
    if (resEmpty.current[pos]) {
      if (newLines.length === 0) return; // empty stays empty — no-op
      const atTop = a.startLineNumber === 1 && a.startColumn === 1;
      const r = new mo.Range(a.startLineNumber, a.startColumn, a.startLineNumber, a.startColumn);
      const text = atTop ? newLines.join("\n") + "\n" : "\n" + newLines.join("\n");
      ed.executeEdits("merge", [{ range: r, text, forceMoveMarkers: true }]);
      setBlockRegion(blockIdx, atTop ? 1 : a.startLineNumber + 1, newLines.length);
    } else if (newLines.length === 0) {
      const lastLine = model.getLineCount();
      let r: any;
      if (a.endLineNumber < lastLine) {
        r = new mo.Range(a.startLineNumber, 1, a.endLineNumber + 1, 1);
      } else {
        const prevEnd = a.startLineNumber > 1 ? model.getLineMaxColumn(a.startLineNumber - 1) : 1;
        r = new mo.Range(Math.max(1, a.startLineNumber - 1), prevEnd, a.endLineNumber, model.getLineMaxColumn(a.endLineNumber));
      }
      ed.executeEdits("merge", [{ range: r, text: "", forceMoveMarkers: true }]);
      setBlockRegion(blockIdx, a.startLineNumber, 0);
    } else {
      const r = new mo.Range(a.startLineNumber, 1, a.endLineNumber, model.getLineMaxColumn(a.endLineNumber));
      ed.executeEdits("merge", [{ range: r, text: newLines.join("\n"), forceMoveMarkers: true }]);
      setBlockRegion(blockIdx, a.startLineNumber, newLines.length);
    }
  };

  const apply = (blockIdx: number, which: Side) => {
    const b = blocks[blockIdx];
    if (!b || changePos(blockIdx) < 0 || !decoRange(blockIdx)) return;
    const next = statusRef.current.slice();
    let lines: string[];
    if (appendBelow(blockIdx, which)) {
      const other: Side = which === "ours" ? "theirs" : "ours";
      lines = [...sideLines(b, other), ...sideLines(b, which)];
      next[blockIdx] = "both";
    } else {
      lines = sideLines(b, which);
      next[blockIdx] = which;
    }
    setStat(next);
    editResult(blockIdx, lines);
  };

  const ignore = (blockIdx: number) => {
    const b = blocks[blockIdx];
    if (!b || changePos(blockIdx) < 0 || !decoRange(blockIdx)) return;
    const next = statusRef.current.slice();
    next[blockIdx] = "base";
    setStat(next);
    editResult(blockIdx, b.base);
  };

  const acceptAll = (which: Side) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    if (!ed || !model || !mo) return;
    const next = statusRef.current.slice();
    const edits = changeIdx
      // Skip regions the user hand-edited so Accept-all doesn't clobber (and strand)
      // their manual content.
      .filter((i) => relevant(blocks[i], which) && statusRef.current[i] !== "edited")
      .map((i) => ({ i, a: decoRange(i) }))
      .filter((x) => x.a)
      // Bottom-up so earlier ranges stay valid as Monaco applies the batch.
      .sort((x, y) => y.a.startLineNumber - x.a.startLineNumber)
      .map(({ i, a }) => {
        next[i] = which;
        const lines = sideLines(blocks[i], which);
        if (resEmpty.current[changePos(i)]) {
          if (!lines.length) return null;
          const atTop = a.startLineNumber === 1 && a.startColumn === 1;
          return {
            range: new mo.Range(a.startLineNumber, a.startColumn, a.startLineNumber, a.startColumn),
            text: atTop ? lines.join("\n") + "\n" : "\n" + lines.join("\n"),
            forceMoveMarkers: true,
          };
        }
        if (!lines.length) {
          const lastLine = model.getLineCount();
          const range =
            a.endLineNumber < lastLine
              ? new mo.Range(a.startLineNumber, 1, a.endLineNumber + 1, 1)
              : new mo.Range(
                  Math.max(1, a.startLineNumber - 1),
                  a.startLineNumber > 1 ? model.getLineMaxColumn(a.startLineNumber - 1) : 1,
                  a.endLineNumber,
                  model.getLineMaxColumn(a.endLineNumber),
                );
          return { range, text: "", forceMoveMarkers: true };
        }
        return {
          range: new mo.Range(a.startLineNumber, 1, a.endLineNumber, model.getLineMaxColumn(a.endLineNumber)),
          text: lines.join("\n"),
          forceMoveMarkers: true,
        };
      })
      .filter(Boolean) as any[];
    if (!edits.length) return;
    setStat(next);
    programmatic.current = true;
    ed.executeEdits("merge", edits);
    rebuildDecos();
  };

  // Rebuild every change decoration from the current model by walking block sizes;
  // used after a multi-region edit (acceptAll) where per-region tracking is moot.
  // Zero-line regions are anchored as collapsed markers so they never overlap the
  // next block.
  const rebuildDecos = () => {
    const model = resRef.current?.getModel();
    const mo = monacoRef.current;
    if (!model || !mo) return;
    let cur = 1;
    const specs: any[] = [];
    const empties: boolean[] = [];
    blocks.forEach((b, i) => {
      const len = isChange(b) ? curLen(i) : b.base.length;
      if (isChange(b)) {
        let range: any;
        if (len === 0) {
          if (cur > 1) {
            const p = Math.min(cur - 1, model.getLineCount());
            const col = model.getLineMaxColumn(p);
            range = new mo.Range(p, col, p, col);
          } else {
            range = new mo.Range(1, 1, 1, 1);
          }
          empties.push(true);
        } else {
          range = new mo.Range(cur, 1, cur + len - 1, 1);
          empties.push(false);
        }
        specs.push({ range, options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
      }
      cur += len;
    });
    resDecoIds.current = model.deltaDecorations(resDecoIds.current, specs);
    resEmpty.current = empties;
  };

  // Lines a change currently contributes to the result, by its status.
  const curLen = (blockIdx: number): number => {
    const b = blocks[blockIdx];
    const st = statusRef.current[blockIdx];
    switch (st) {
      case "ours":
        return b.ours.length;
      case "theirs":
        return b.theirs.length;
      case "both":
        return b.ours.length + b.theirs.length;
      case "base":
        return b.base.length;
      case "pending":
        return initResult(b).length;
      default: {
        // edited — measure the live range
        const r = resRange(blockIdx);
        return r ? r.end - r.start + 1 : 0;
      }
    }
  };

  // ---- diagonal alignment: per-pane line layout, scroll mapping, connectors ----

  const LH = 19; // sideOptions.lineHeight; panes have no word-wrap so this is exact.

  // Cumulative 1-based start line of each block in a pane; `arr[blocks.length]` is
  // the line after the last block. The result column is live (status-driven).
  const lineStarts = (kind: "ours" | "theirs" | "result"): number[] => {
    const arr = [1];
    blocks.forEach((b, i) => {
      const len = kind === "result" ? (isChange(b) ? curLen(i) : b.base.length) : sideLines(b, kind).length;
      arr.push(arr[arr.length - 1] + len);
    });
    return arr;
  };

  // Map a pane's scrollTop to the equivalent scrollTop in another pane, piecewise-
  // linear across the shared block boundaries — so the region at the top of one pane
  // sits at the top of the others and the connectors stay continuous.
  const mapScroll = (srcStarts: number[], dstStarts: number[], srcScroll: number): number => {
    const srcLine = srcScroll / LH + 1;
    let b = 0;
    while (b < srcStarts.length - 2 && srcStarts[b + 1] <= srcLine) b++;
    const sLen = srcStarts[b + 1] - srcStarts[b];
    const frac = sLen > 0 ? (srcLine - srcStarts[b]) / sLen : 0;
    const dLen = dstStarts[b + 1] - dstStarts[b];
    const dstLine = dstStarts[b] + frac * dLen;
    return Math.max(0, (dstLine - 1) * LH);
  };

  const editorName = (ed: any): "ours" | "theirs" | "result" | null =>
    ed === oursRef.current ? "ours" : ed === theirsRef.current ? "theirs" : ed === resRef.current ? "result" : null;

  // Viewport-relative [top, bottom] px of a block's span in an editor, expressed in
  // the gutter SVG's local coordinates (origin = `baseTop`). A 0-line region is a point.
  const spanY = (ed: any, startLine: number, len: number, baseTop: number): [number, number] => {
    const domTop = ed.getDomNode()?.getBoundingClientRect().top ?? 0;
    const scroll = ed.getScrollTop();
    const top = domTop + ed.getTopForLineNumber(startLine) - scroll - baseTop;
    const bot = len > 0 ? domTop + ed.getTopForLineNumber(startLine + len) - scroll - baseTop : top;
    return [top, bot];
  };

  // Connector polygons for one gutter (0 = ours↔result, 1 = result↔theirs), bridging
  // each change's span on the left pane to its span on the right pane.
  const connectors = (gutter: 0 | 1) => {
    void tick; // recompute on scroll / layout / status
    void status;
    const leftEd = gutter === 0 ? oursRef.current : resRef.current;
    const rightEd = gutter === 0 ? resRef.current : theirsRef.current;
    const leftKind = gutter === 0 ? "ours" : "result";
    const rightKind = gutter === 0 ? "result" : "theirs";
    const split = (gutter === 0 ? split0Ref : split1Ref).current;
    if (!leftEd || !rightEd || !split) return null;
    const rect = split.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const ls = lineStarts(leftKind as "ours" | "theirs" | "result");
    const rs = lineStarts(rightKind as "ours" | "theirs" | "result");
    const polys = changeIdx
      .map((i) => {
        const cls = resCls(i);
        if (!cls) return null;
        const [lt, lb] = spanY(leftEd, ls[i], ls[i + 1] - ls[i], rect.top);
        const [rt, rb] = spanY(rightEd, rs[i], rs[i + 1] - rs[i], rect.top);
        if (Math.max(lb, rb) < 0 || Math.min(lt, rt) > H) return null; // off-screen
        return { i, cls, points: `0,${lt} ${W},${rt} ${W},${rb} 0,${lb}` };
      })
      .filter(Boolean) as { i: number; cls: string; points: string }[];
    return (
      <svg className="merge-conn" width={W} height={H} preserveAspectRatio="none">
        {polys.map((p) => (
          <polygon key={p.i} points={p.points} className={`mc-${p.cls}`} />
        ))}
      </svg>
    );
  };

  // Band colour for a change. Conflicts are "danger"; one-sided changes carry
  // their side accent; resolved blocks use the chosen-side colour.
  const resCls = useCallback(
    (i: number): string | null => {
      const b = blocks[i];
      const s = statusRef.current[i];
      if (!b || !isChange(b) || s === "edited") return null;
      if (b.kind === "conflict" && s === "pending") return "conflict";
      if (s === "pending") return b.kind;
      if (s === "base") return null;
      return s;
    },
    [blocks],
  );

  const sideCls = useCallback(
    (i: number, which: Side): string | null => {
      const b = blocks[i];
      if (!b || !relevant(b, which)) return null;
      const s = statusRef.current[i];
      if (!(s === "pending" || appendBelow(i, which))) return null;
      return b.kind === "conflict" ? "conflict" : which;
    },
    [blocks, appendBelow],
  );

  // ---- decorations: side bands + result highlight ----

  const paint = useCallback(() => {
    const mo = monacoRef.current;
    if (!mo) return;
    const R = (a: number, b: number) => new mo.Range(a, 1, b, 1);

    const sideDecos = (side: Side) =>
      blocks
        .map((_b, i) => ({ i, cls: sideCls(i, side), r: side === "ours" ? sideRanges.ours[i] : sideRanges.theirs[i] }))
        .filter((x) => x.cls && x.r && x.r.end >= x.r.start)
        .map((x) => ({
          range: R(x.r!.start, x.r!.end),
          options: { isWholeLine: true, className: x.cls === "conflict" ? "merge-line-conflict" : `merge-line-${x.cls}` },
        }));

    if (oursRef.current) {
      decoRefs.current.ours = decoRefs.current.ours ?? oursRef.current.createDecorationsCollection([]);
      decoRefs.current.ours.set(sideDecos("ours"));
    }
    if (theirsRef.current) {
      decoRefs.current.theirs = decoRefs.current.theirs ?? theirsRef.current.createDecorationsCollection([]);
      decoRefs.current.theirs.set(sideDecos("theirs"));
    }
    if (resRef.current) {
      const decos = changeIdx
        .map((i) => ({ i, r: resRange(i), cls: resCls(i) }))
        .filter((x) => x.cls && !isEmptyRegion(x.i) && x.r && x.r!.end >= x.r!.start)
        .map((x) => ({ range: R(x.r!.start, x.r!.end), options: { isWholeLine: true, className: `merge-res-${x.cls}` } }));
      decoRefs.current.res = decoRefs.current.res ?? resRef.current.createDecorationsCollection([]);
      decoRefs.current.res.set(decos);
    }
  }, [blocks, sideRanges, changeIdx, resRange, sideCls, resCls]);

  useEffect(() => {
    paint();
    bump();
  }, [paint, status, w, ready]);

  // Connectors are drawn from live editor geometry; recompute on window resize.
  useEffect(() => {
    const onResize = () => bump();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- result model: init decorations + unified-undo status tracking ----

  const onResultContent = useCallback(
    (e: any) => {
      const model = resRef.current?.getModel();
      if (!model) return;
      const altId = model.getAlternativeVersionId();
      const known = statusByAlt.current.get(altId);
      if (known) {
        // Undo/redo landed on a state we've seen — restore its status in lockstep,
        // then rebuild the change decorations so they match the reverted content
        // (Monaco does not snapshot decorations across undo).
        setStat(known.slice());
        rebuildDecos();
      } else if (programmatic.current) {
        programmatic.current = false;
        statusByAlt.current.set(altId, statusRef.current.slice());
        capStatusByAlt();
      } else {
        // Manual keystroke: any change region the edit touched becomes `edited`.
        const next = statusRef.current.slice();
        const touched = (e?.changes ?? []).map((c: any) => c.range);
        changeIdx.forEach((bi) => {
          const r = resRange(bi);
          if (!r) return;
          const hit = touched.some((tr: any) => tr.startLineNumber <= r.end && tr.endLineNumber >= r.start);
          if (hit) next[bi] = "edited";
        });
        setStat(next);
        statusByAlt.current.set(altId, next.slice());
        capStatusByAlt();
      }
      paint();
      bump();
    },
    [changeIdx, resRange, paint],
  );

  // Bound the undo-snapshot map so a long editing session can't leak memory.
  const capStatusByAlt = () => {
    const m = statusByAlt.current;
    while (m.size > 600) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };

  // Vertical scroll sync: map the source pane's scrollTop into each other pane
  // through the shared block boundaries so the connectors stay continuous.
  const lockScroll = (src: any) => {
    src.onDidScrollChange(() => {
      bump();
      if (syncing.current) return;
      const srcName = editorName(src);
      if (!srcName) return;
      syncing.current = true;
      const srcStarts = lineStarts(srcName);
      const srcScroll = src.getScrollTop();
      for (const [name, ed] of [
        ["ours", oursRef.current],
        ["theirs", theirsRef.current],
        ["result", resRef.current],
      ] as const) {
        if (!ed || ed === src) continue;
        ed.setScrollTop(mapScroll(srcStarts, lineStarts(name), srcScroll));
        ed.setScrollLeft(src.getScrollLeft());
      }
      syncing.current = false;
    });
  };

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
    const model = ed.getModel();
    // Seed one decoration per change block over its initial result span; a zero-line
    // region becomes a collapsed insertion anchor (see setBlockRegion).
    let cur = 1;
    const specs: any[] = [];
    const empties: boolean[] = [];
    blocks.forEach((b) => {
      const len = initResult(b).length;
      if (isChange(b)) {
        let range: any;
        if (len === 0) {
          if (cur > 1) {
            const p = Math.min(cur - 1, model.getLineCount());
            const col = model.getLineMaxColumn(p);
            range = new mo.Range(p, col, p, col);
          } else {
            range = new mo.Range(1, 1, 1, 1);
          }
          empties.push(true);
        } else {
          range = new mo.Range(cur, 1, cur + len - 1, 1);
          empties.push(false);
        }
        specs.push({ range, options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
      }
      cur += len;
    });
    resDecoIds.current = model.deltaDecorations([], specs);
    resEmpty.current = empties;
    statusByAlt.current.set(model.getAlternativeVersionId(), statusRef.current.slice());
    model.onDidChangeContent(onResultContent);
    lockScroll(ed);
    setReady((r) => r + 1);
  };

  // ---- overlay buttons (side panes) ----

  const lineTop = (ed: any, line: number, hostH: number): number | null => {
    if (!ed) return null;
    const y = ed.getTopForLineNumber(line) - ed.getScrollTop();
    return y >= -2 && y <= hostH - 12 ? y : null;
  };

  const sideActions = (which: Side) => {
    void tick;
    const ed = which === "ours" ? oursRef.current : theirsRef.current;
    const hostH = ed?.getLayoutInfo?.().height ?? 0;
    const ranges = which === "ours" ? sideRanges.ours : sideRanges.theirs;
    return blocks
      .map((b, i) => {
        if (!relevant(b, which)) return null;
        const st = status[i];
        const append = appendBelow(i, which);
        // Once acted on, the side's buttons go — except the still-available ↓.
        if (st !== "pending" && !append) return null;
        const r = ranges[i];
        const top = lineTop(ed, r.start, hostH);
        if (top == null) return null;
        const accept = (
          <button
            key="a"
            className={`mact accept ${which}${append ? " add" : ""}`}
            title={append ? "Add this side below the other (keep both)" : "Accept this change into the result"}
            onClick={() => apply(i, which)}
          >
            {append ? "↓" : which === "ours" ? "»" : "«"}
          </button>
        );
        const skip = (
          <button key="x" className="mact ignore" title="Ignore this change (keep base)" onClick={() => ignore(i)}>
            ×
          </button>
        );
        return (
          <div key={i} className="mact-row" style={{ top }}>
            {which === "ours" ? [skip, accept] : [accept, skip]}
          </div>
        );
      })
      .filter(Boolean);
  };

  // Jump between changes (F7 / Shift+F7) in the result pane.
  const [cur, setCur] = useState(-1);
  const navDiff = useCallback(
    (dir: 1 | -1) => {
      if (!changeIdx.length) return;
      const p = changeIdx.indexOf(cur);
      const nextIdx =
        p < 0 ? (dir > 0 ? changeIdx[0] : changeIdx[changeIdx.length - 1]) : changeIdx[(p + dir + changeIdx.length) % changeIdx.length];
      setCur(nextIdx);
      const r = resRange(nextIdx);
      if (r && resRef.current) {
        resRef.current.revealLineInCenter(Math.max(r.start, 1));
        resRef.current.setPosition({ lineNumber: Math.max(r.start, 1), column: 1 });
      }
    },
    [changeIdx, cur, resRange],
  );

  // ---- unified undo/redo (Monaco native) ----

  const undo = () => resRef.current?.trigger("merge", "undo", null);
  const redo = () => resRef.current?.trigger("merge", "redo", null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
        // Let the result editor handle it natively when focused; otherwise route.
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
  }, [onClose, navDiff]);

  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);

  // All conflicts done → write the merged buffer, stage, emit, close.
  async function doResolve() {
    const model = resRef.current?.getModel();
    // Nothing mounted, or a degenerate/stale buffer with no real change blocks: just
    // close — writing model.getValue() here would clobber the file (e.g. truncate it
    // to "") for a path that is no longer conflicted.
    if (!model || changeCount === 0) {
      closingRef.current = true;
      onClose();
      return;
    }
    try {
      await api.gitResolveConflict(repoPath, path, model.getValue());
      closingRef.current = true;
      onResolved();
    } catch (e) {
      toast(String(e), true);
    }
  }

  // Close request (Close button / native red button): apply silently when every
  // conflict is resolved, otherwise warn before discarding (JetBrains-style).
  const attemptClose = () => {
    if (remaining > 0) setConfirmClose(true);
    else doResolve();
  };
  const discardAndClose = () => {
    closingRef.current = true;
    setConfirmClose(false);
    onClose();
  };
  // Bottom-bar Cancel: discard and close, confirming first when work would be lost.
  const cancel = () => {
    if (remaining > 0) setConfirmClose(true);
    else discardAndClose();
  };
  // Bottom-bar Apply: with conflicts still unresolved, confirm first (then write,
  // marking them resolved at their default side); otherwise apply straight away.
  const applyMerge = () => {
    if (remaining > 0) setConfirmApply(true);
    else doResolve();
  };

  // Announce success once. Not re-armed when `remaining` goes back above 0, so
  // undo/redo across the last-conflict threshold doesn't re-fire the toast.
  const announced = useRef(false);
  useEffect(() => {
    if (remaining === 0 && changeCount > 0 && blocks.length > 0 && !announced.current) {
      announced.current = true;
      toast(`All conflicts resolved in ${basename(path)} — click Apply`);
    }
  }, [remaining, changeCount, blocks.length, path]);

  // In a standalone window, route the OS close button through the same guard.
  useEffect(() => {
    if (!windowed) return;
    const win = getCurrentWindow();
    const un = win.onCloseRequested((e) => {
      if (closingRef.current) return;
      e.preventDefault();
      attemptClose();
    });
    return () => {
      un.then((f) => f());
    };
    // attemptClose reads `remaining` via closure; re-subscribe when it changes.
  }, [windowed, remaining]);

  const panesRef = useRef<HTMLDivElement>(null);
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
    const onMove = (ev: MouseEvent) => {
      setPos({ x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) });
    };
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
    lineHeight: 19,
    minimap: { enabled: false },
    renderLineHighlight: "none" as const,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    glyphMargin: true,
    readOnly: true,
    lineNumbersMinChars: 3,
    padding: { top: 8, bottom: 8 },
  };

  const shell = (
      <div
        className={`merge-modal${windowed ? " windowed" : ""}`}
        style={!windowed && pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
      >
        <div className="merge-bar" onMouseDown={windowed ? undefined : dragModal}>
          <button className="tbtn icon" title="Previous difference (Shift+F7)" onClick={() => navDiff(-1)}>
            ↑
          </button>
          <button className="tbtn icon" title="Next difference (F7)" onClick={() => navDiff(1)}>
            ↓
          </button>
          <button className="tbtn icon" title="Undo (⌘Z)" onClick={undo}>
            ↶
          </button>
          <button className="tbtn icon" title="Redo (⌘⇧Z)" onClick={redo}>
            ↷
          </button>
          <span className="merge-file" title={path}>
            {basename(path)}
          </span>
          <span className={`merge-status${remaining ? " bad" : " ok"}`}>
            {remaining
              ? `${changeCount} change${changeCount === 1 ? "" : "s"} · ${remaining} conflict${remaining === 1 ? "" : "s"} left`
              : "✓ All conflicts resolved"}
          </span>
        </div>

        {blocks.length === 0 ? (
          <div className="merge-panes">
            <div className="dbg-hint">Loading…</div>
          </div>
        ) : (
        <div className="merge-panes" ref={panesRef}>
          <div className="merge-pane" style={{ flexGrow: w[0] }}>
            <div className="merge-plabel ours">
              <span className="dpb-ico" aria-hidden="true">⎇</span>
              <span className="dpb-ref" title={`Changes from ${oursLabel}`}>Changes from {oursLabel}</span>
              <span className="dpb-lock" aria-hidden="true" title="Read-only">🔒</span>
            </div>
            <div className="merge-edhost">
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
                options={sideOptions}
              />
              <div className="mact-layer ours">{sideActions("ours")}</div>
            </div>
          </div>

          <div className="merge-split" ref={split0Ref} onMouseDown={dragSplit(0)}>
            {connectors(0)}
          </div>

          <div className="merge-pane center" style={{ flexGrow: w[1] }}>
            <div className="merge-plabel result">
              <span className="dpb-ico" aria-hidden="true">✎</span>
              <span className="dpb-ref">Result</span>
              <span className="dpb-file" title={path}>{basename(path)}</span>
            </div>
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
              options={{ ...sideOptions, readOnly: false }}
            />
          </div>

          <div className="merge-split" ref={split1Ref} onMouseDown={dragSplit(1)}>
            {connectors(1)}
          </div>

          <div className="merge-pane" style={{ flexGrow: w[2] }}>
            <div className="merge-plabel theirs">
              <span className="dpb-lock" aria-hidden="true" title="Read-only">🔒</span>
              <span className="dpb-ico" aria-hidden="true">⎇</span>
              <span className="dpb-ref" title={`Changes from ${theirsLabel}`}>Changes from {theirsLabel}</span>
            </div>
            <div className="merge-edhost">
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
                options={sideOptions}
              />
              <div className="mact-layer theirs">{sideActions("theirs")}</div>
            </div>
          </div>
        </div>
        )}

        <div className="merge-foot">
          <div className="merge-foot-l">
            <button
              className="tbtn"
              disabled={blocks.length === 0}
              onClick={() => acceptAll("ours")}
              title={`Take every change from ${oursLabel}`}
            >
              Accept Left
            </button>
            <button
              className="tbtn"
              disabled={blocks.length === 0}
              onClick={() => acceptAll("theirs")}
              title={`Take every change from ${theirsLabel}`}
            >
              Accept Right
            </button>
          </div>
          <div className="merge-foot-r">
            <button className="tbtn" onClick={cancel}>
              Cancel
            </button>
            <button
              className="tbtn primary"
              disabled={changeCount === 0}
              title="Apply the merge and close"
              onClick={applyMerge}
            >
              Apply
            </button>
          </div>
        </div>

        {confirmClose && (
          <ConfirmModal
            title="Unresolved conflicts"
            danger
            message={
              <>
                {remaining} conflict{remaining === 1 ? "" : "s"} in <b>{basename(path)}</b>{" "}
                {remaining === 1 ? "is" : "are"} still unresolved. Close without applying? Your resolutions
                won’t be saved.
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
                    There are {unprocessed} change{unprocessed === 1 ? "" : "s"} and {remaining} conflict
                    {remaining === 1 ? "" : "s"} left unprocessed.{" "}
                  </>
                ) : (
                  <>
                    {remaining === 1 ? "There is" : "There are"} {remaining} conflict{remaining === 1 ? "" : "s"} left
                    unprocessed.{" "}
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

  if (windowed) return <div className="merge-window">{shell}</div>;
  return createPortal(
    <div className="merge-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {shell}
    </div>,
    document.body,
  );
}

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
  const zoneIds = useRef<{ ours: string[]; theirs: string[]; result: string[] }>({ ours: [], theirs: [], result: [] });
  const syncing = useRef(false);

  // Synchronous mirror of `status` (React state is async; the Monaco content
  // callback needs the live value) + the change-region decoration ids on the
  // result model, in change-block order.
  const statusRef = useRef<St[]>([]);
  const resDecoIds = useRef<string[]>([]);
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
      const bs = await api.gitMergeBlocks(repoPath, path);
      if (!alive) return;
      setBlocks(bs);
      setStat(bs.map(initStatus));
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

  const replaceResult = (range: Range3, newLines: string[]) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    if (!ed || !model || !mo) return;
    const lastLine = model.getLineCount();
    let r: any;
    let text: string;
    if (newLines.length === 0) {
      if (range.end < lastLine) {
        r = new mo.Range(range.start, 1, range.end + 1, 1);
      } else {
        const prevEnd = range.start > 1 ? model.getLineMaxColumn(range.start - 1) : 1;
        r = new mo.Range(Math.max(1, range.start - 1), prevEnd, range.end, model.getLineMaxColumn(range.end));
      }
      text = "";
    } else {
      r = new mo.Range(range.start, 1, range.end, model.getLineMaxColumn(range.end));
      text = newLines.join("\n");
    }
    programmatic.current = true;
    ed.executeEdits("merge", [{ range: r, text, forceMoveMarkers: true }]);
  };

  // Reset a change's decoration to a known line span (after our own edit, where we
  // know the exact resulting length).
  const setResDeco = (blockIdx: number, start: number, len: number) => {
    const model = resRef.current?.getModel();
    const mo = monacoRef.current;
    if (!model || !mo) return;
    const pos = changeIdx.indexOf(blockIdx);
    const oldId = resDecoIds.current[pos];
    const end = Math.max(start, start + len - 1);
    const [newId] = model.deltaDecorations(oldId ? [oldId] : [], [
      {
        range: new mo.Range(start, 1, end, 1),
        options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      },
    ]);
    resDecoIds.current[pos] = newId;
  };

  const apply = (blockIdx: number, which: Side) => {
    const b = blocks[blockIdx];
    const range = resRange(blockIdx);
    if (!b || !range) return;
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
    replaceResult(range, lines);
    setResDeco(blockIdx, range.start, lines.length);
  };

  const ignore = (blockIdx: number) => {
    const b = blocks[blockIdx];
    const range = resRange(blockIdx);
    if (!b || !range) return;
    const next = statusRef.current.slice();
    next[blockIdx] = "base";
    setStat(next);
    replaceResult(range, b.base);
    setResDeco(blockIdx, range.start, b.base.length);
  };

  const acceptAll = (which: Side) => {
    const ed = resRef.current;
    const model = ed?.getModel();
    const mo = monacoRef.current;
    if (!ed || !model || !mo) return;
    const next = statusRef.current.slice();
    // Bottom-up so earlier ranges stay valid as we splice.
    const edits = changeIdx
      .filter((i) => relevant(blocks[i], which))
      .map((i) => ({ i, r: resRange(i) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r!.start - a.r!.start)
      .map(({ i, r }) => {
        next[i] = which;
        return {
          range: new mo.Range(r!.start, 1, r!.end, model.getLineMaxColumn(r!.end)),
          text: sideLines(blocks[i], which).join("\n"),
          forceMoveMarkers: true,
        };
      });
    if (!edits.length) return;
    setStat(next);
    programmatic.current = true;
    ed.executeEdits("merge", edits);
    rebuildDecos();
  };

  // Rebuild every change decoration from the current model by walking block sizes;
  // used after a multi-region edit (acceptAll) where per-region tracking is moot.
  const rebuildDecos = () => {
    const model = resRef.current?.getModel();
    const mo = monacoRef.current;
    if (!model || !mo) return;
    // Best-effort: recompute spans from current statuses' contributed lengths.
    let cur = 1;
    const specs: { range: any }[] = [];
    const order: number[] = [];
    blocks.forEach((b, i) => {
      const len = isChange(b) ? curLen(i) : b.base.length;
      if (isChange(b)) {
        order.push(i);
        specs.push({
          range: new mo.Range(cur, 1, Math.max(cur, cur + len - 1), 1),
          options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } as any,
        } as any);
      }
      cur += len;
    });
    const ids = model.deltaDecorations(resDecoIds.current, specs as any);
    // order matches changeIdx order (blocks iterated ascending)
    resDecoIds.current = ids;
    void order;
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
        .filter((x) => x.cls && x.r && x.r!.end >= x.r!.start)
        .map((x) => ({ range: R(x.r!.start, x.r!.end), options: { isWholeLine: true, className: `merge-res-${x.cls}` } }));
      decoRefs.current.res = decoRefs.current.res ?? resRef.current.createDecorationsCollection([]);
      decoRefs.current.res.set(decos);
    }
  }, [blocks, sideRanges, changeIdx, resRange, sideCls, resCls]);

  // Spacer view-zones so each block lines up across the three panes.
  const applyZones = useCallback(() => {
    const editors: Record<"ours" | "theirs" | "result", any> = {
      ours: oursRef.current,
      theirs: theirsRef.current,
      result: resRef.current,
    };
    (["ours", "theirs", "result"] as const).forEach((which) => {
      const ed = editors[which];
      if (!ed) return;
      let line = 0;
      const plan: { afterLineNumber: number; heightInLines: number; cls: string | null }[] = [];
      blocks.forEach((b, i) => {
        const cOurs = sideLines(b, "ours").length;
        const cTheirs = sideLines(b, "theirs").length;
        const cRes = isChange(b) ? curLen(i) : b.base.length;
        const h = Math.max(cOurs, cTheirs, cRes);
        const cnt = which === "ours" ? cOurs : which === "theirs" ? cTheirs : cRes;
        line += cnt;
        // Tint the spacer with the block's band colour so an aligned change reads
        // as one continuous strip (no blank gap), JetBrains-style.
        const cls = which === "result" ? resCls(i) : sideCls(i, which);
        if (h - cnt > 0) plan.push({ afterLineNumber: line, heightInLines: h - cnt, cls });
      });
      ed.changeViewZones((acc: any) => {
        zoneIds.current[which].forEach((id) => acc.removeZone(id));
        zoneIds.current[which] = plan.map((z) => {
          const dom = document.createElement("div");
          dom.className = `merge-spacer${z.cls ? ` sp-${z.cls}` : ""}`;
          return acc.addZone({ afterLineNumber: z.afterLineNumber, heightInLines: z.heightInLines, domNode: dom });
        });
      });
    });
  }, [blocks, resCls, sideCls]);

  useEffect(() => {
    paint();
    applyZones();
    bump();
  }, [paint, applyZones, status, w, ready]);

  // ---- result model: init decorations + unified-undo status tracking ----

  const onResultContent = useCallback(
    (e: any) => {
      const model = resRef.current?.getModel();
      if (!model) return;
      const altId = model.getAlternativeVersionId();
      const known = statusByAlt.current.get(altId);
      if (known) {
        // Undo/redo landed on a state we've seen — restore its status in lockstep.
        setStat(known.slice());
      } else if (programmatic.current) {
        programmatic.current = false;
        statusByAlt.current.set(altId, statusRef.current.slice());
      } else {
        // Manual keystroke: any change region the edit touched becomes `edited`.
        const next = statusRef.current.slice();
        const touched = (e?.changes ?? []).map((c: any) => c.range);
        changeIdx.forEach((bi) => {
          const r = resRange(bi);
          if (!r) return;
          const hit = touched.some((tr: any) => tr.startLineNumber <= r.end + 1 && tr.endLineNumber >= r.start);
          if (hit) next[bi] = "edited";
        });
        setStat(next);
        statusByAlt.current.set(altId, next.slice());
      }
      paint();
      applyZones();
      bump();
    },
    [changeIdx, resRange, paint, applyZones],
  );

  const lockScroll = (src: any) => {
    src.onDidScrollChange((e: any) => {
      bump();
      if (syncing.current) return;
      syncing.current = true;
      for (const ed of [oursRef.current, theirsRef.current, resRef.current]) {
        if (ed && ed !== src) ed.setScrollTop(e.scrollTop);
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
    // Seed one decoration per change block over its initial result span.
    let cur = 1;
    const specs: any[] = [];
    blocks.forEach((b) => {
      const len = initResult(b).length;
      if (isChange(b)) {
        specs.push({
          range: new mo.Range(cur, 1, Math.max(cur, cur + len - 1), 1),
          options: { stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        });
      }
      cur += len;
    });
    resDecoIds.current = model.deltaDecorations([], specs);
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

  // ---- unified undo/redo (Monaco native) ----

  const undo = () => resRef.current?.trigger("merge", "undo", null);
  const redo = () => resRef.current?.trigger("merge", "redo", null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
  }, [onClose]);

  // Set just before we close the window ourselves, so the onCloseRequested guard
  // lets the close through instead of re-prompting.
  const closingRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // All conflicts done → write the merged buffer, stage, emit, close.
  async function doResolve() {
    const model = resRef.current?.getModel();
    if (!model) return;
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

  // Announce success once, when the last conflict is resolved.
  const announced = useRef(false);
  useEffect(() => {
    if (remaining > 0) {
      announced.current = false;
    } else if (changeCount > 0 && blocks.length > 0 && !announced.current) {
      announced.current = true;
      toast(`All conflicts resolved in ${basename(path)} — close to apply`);
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

  // Jump between changes (F7 / Shift+F7) in the result pane.
  const [cur, setCur] = useState(-1);
  const navDiff = (dir: 1 | -1) => {
    if (!changeIdx.length) return;
    const p = changeIdx.indexOf(cur);
    const nextIdx = p < 0 ? (dir > 0 ? changeIdx[0] : changeIdx[changeIdx.length - 1]) : changeIdx[(p + dir + changeIdx.length) % changeIdx.length];
    setCur(nextIdx);
    const r = resRange(nextIdx);
    if (r && resRef.current) {
      resRef.current.revealLineInCenter(Math.max(r.start, 1));
      resRef.current.setPosition({ lineNumber: Math.max(r.start, 1), column: 1 });
    }
  };

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
          <div className="merge-apply">
            <span>Apply all:</span>
            <button className="tbtn" onClick={() => acceptAll("ours")} title={`Take every change from ${oursLabel}`}>
              ≪ Left
            </button>
            <button className="tbtn" onClick={() => acceptAll("theirs")} title={`Take every change from ${theirsLabel}`}>
              Right ≫
            </button>
          </div>
          <span className="merge-file" title={path}>
            {basename(path)}
          </span>
          <span className={`merge-status${remaining ? " bad" : " ok"}`}>
            {remaining
              ? `${changeCount} change${changeCount === 1 ? "" : "s"} · ${remaining} conflict${remaining === 1 ? "" : "s"} left`
              : "✓ All conflicts resolved — close the window to apply"}
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
              <span className="dpb-ref">Changes from {oursLabel}</span>
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

          <div className="merge-split" onMouseDown={dragSplit(0)} />

          <div className="merge-pane center" style={{ flexGrow: w[1] }}>
            <div className="merge-plabel result">
              <span className="dpb-ico" aria-hidden="true">✎</span>
              <span className="dpb-ref">Result</span>
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

          <div className="merge-split" onMouseDown={dragSplit(1)} />

          <div className="merge-pane" style={{ flexGrow: w[2] }}>
            <div className="merge-plabel theirs">
              <span className="dpb-ico" aria-hidden="true">⎇</span>
              <span className="dpb-ref">Changes from {theirsLabel}</span>
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

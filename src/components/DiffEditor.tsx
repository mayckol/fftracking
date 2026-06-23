import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DiffEditor as MonacoDiff, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { HunkInfo } from "../lib/types";
import { defineAllThemes, monacoThemeId } from "./monacoTheme";
import { initPluginsForMonaco } from "../lib/plugins/registry";
import { registerEditor } from "../lib/selection";
import { monacoModifiers } from "../lib/shortcuts";
import { editorPrefOptions, useUIPrefs } from "../lib/uiPrefs";

export interface DiffHandle {
  /** Move to the next/prev change. Returns "boundary" when already at the last
   *  (next) / first (prev) change so the caller can hop to the adjacent file. */
  navigate: (dir: "next" | "prev") => "moved" | "boundary";
  focusFirst: () => void;
  focusLast: () => void;
  revertCurrent: () => void;
  undo: () => void;
  redo: () => void;
}

interface Props {
  original: string;
  modified: string;
  language: string;
  inline?: boolean;
  editable?: boolean;
  onCommit?: (value: string) => void;
  /** Backend hunks; each gets an always-visible apply (→) icon in the gutter. */
  hunks?: HunkInfo[];
  /** Which side the right/modified pane shows: false = current/working
   *  (hunk old_*), true = the target/point (hunk new_*). */
  targetSide?: boolean;
  /** Revision labels shown above each pane (e.g. a branch or commit) so it's
   *  clear which side is which. Left = original, right = modified. */
  originalLabel?: string;
  modifiedLabel?: string;
  /** Right pane is the live working tree (your editable copy) — marked with a
   *  green pencil rather than a branch glyph. */
  modifiedWorking?: boolean;
  /** Apply a block into the working tree when neither pane is editable (a
   *  two-revision compare). Receives the hunk index; the backend splices it.
   *  When set, the apply (→) arrows show even though the panes are read-only. */
  onApplyHunk?: (index: number) => void;
}

const DiffEditor = forwardRef<DiffHandle, Props>(function DiffEditor(
  { original, modified, language, inline = false, editable = false, onCommit, hunks = [], targetSide = false, originalLabel, modifiedLabel, modifiedWorking = false, onApplyHunk },
  ref,
) {
  const prefs = useUIPrefs();
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;
  // onMount captures handlers once; read the live apply callback through a ref.
  const onApplyHunkRef = useRef(onApplyHunk);
  onApplyHunkRef.current = onApplyHunk;
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const hunksRef = useRef<HunkInfo[]>(hunks);
  const decoRef = useRef<string[]>([]);
  const activeDecoRef = useRef<string[]>([]);
  const navRef = useRef(-1);
  const [identical, setIdentical] = useState(false);

  function reveal(idx: number, focus: boolean) {
    const diff = diffRef.current;
    const monaco = monacoRef.current;
    const changes = diff?.getLineChanges() ?? [];
    if (!diff || !monaco || changes.length === 0) return;
    navRef.current = idx;
    const c = changes[idx];
    const hasMod = c.modifiedStartLineNumber > 0;
    const line = hasMod ? c.modifiedStartLineNumber : c.modifiedEndLineNumber || 1;
    const me = diff.getModifiedEditor();
    me.revealLineNearTop(line);
    me.setPosition({ lineNumber: line, column: 1 });
    // Highlight the change you landed on (a whole-line band + scrollbar tick) so
    // it's obvious which one is active — not just a scroll to the file.
    const start = hasMod ? c.modifiedStartLineNumber : Math.max(1, line);
    const end = hasMod && c.modifiedEndLineNumber >= start ? c.modifiedEndLineNumber : start;
    activeDecoRef.current = me.deltaDecorations(activeDecoRef.current, [
      {
        range: new monaco.Range(start, 1, end, 1),
        options: {
          isWholeLine: true,
          className: "ff-active-change",
          overviewRuler: { color: "#7c8cff", position: monaco.editor.OverviewRulerLane.Full },
        },
      },
    ]);
    if (focus) me.focus();
  }

  // Cross-file nav switches the file first; its diff is recomputed async, so the
  // first/last change isn't known yet — retry until Monaco has the line changes.
  function revealEdge(which: "first" | "last", focus: boolean, tries = 30) {
    const changes = diffRef.current?.getLineChanges() ?? [];
    if (changes.length === 0) {
      if (tries > 0) window.setTimeout(() => revealEdge(which, focus, tries - 1), 50);
      return;
    }
    reveal(which === "first" ? 0 : changes.length - 1, focus);
  }

  useImperativeHandle(ref, () => ({
    navigate(dir) {
      const changes = diffRef.current?.getLineChanges() ?? [];
      const n = changes.length;
      if (n === 0) return "boundary";
      const target = dir === "next" ? navRef.current + 1 : navRef.current - 1;
      if (target < 0 || target >= n) return "boundary";
      reveal(target, true);
      return "moved";
    },
    focusFirst() {
      revealEdge("first", true);
    },
    focusLast() {
      revealEdge("last", true);
    },
    revertCurrent() {
      const diff = diffRef.current;
      if (!diff || hunksRef.current.length === 0) return;
      const line = diff.getModifiedEditor().getPosition()?.lineNumber ?? 1;
      // The block whose start is nearest the cursor (so a keyboard apply acts on
      // the change you navigated to).
      const hit = hunksRef.current.reduce((best, h) =>
        Math.abs(lineOf(h) - line) < Math.abs(lineOf(best) - line) ? h : best,
      );
      applyHit(hit);
    },
    undo() {
      const me = diffRef.current?.getModifiedEditor();
      me?.focus();
      me?.trigger("ff", "undo", null);
    },
    redo() {
      const me = diffRef.current?.getModifiedEditor();
      me?.focus();
      me?.trigger("ff", "redo", null);
    },
  }));

  // Icon sits on the right/modified pane at the hunk start. old_* = current
  // (working) side, new_* = target (point) side — pick per which pane is shown.
  // A pure deletion (len 0) has no line on this side, so it anchors on the line
  // above the gap (start, not start+1) — otherwise the glyph drifts one row below
  // the change. Mirrors the main editor's gutter-stripe anchor.
  function lineOf(h: HunkInfo) {
    const start = targetSide ? h.new_start : h.old_start;
    const len = targetSide ? h.new_len : h.old_len;
    return len > 0 ? start + 1 : Math.max(1, start);
  }

  // Restores one block of the modified (working) pane to the original (point)
  // side via an editor edit — so it lands in the native undo stack (Cmd+Z /
  // redo) and only touches that block, never blanking the file.
  function revertHunk(h: HunkInfo) {
    const diff = diffRef.current;
    const monaco = monacoRef.current;
    if (!diff || !monaco) return;
    const orig = diff.getOriginalEditor().getModel();
    if (!orig) return;
    const repl =
      h.new_len > 0
        ? orig.getValueInRange(new monaco.Range(h.new_start + 1, 1, h.new_start + h.new_len + 1, 1))
        : "";
    const range = new monaco.Range(h.old_start + 1, 1, h.old_start + h.old_len + 1, 1);
    const me = diff.getModifiedEditor();
    me.executeEdits("ff-revert", [{ range, text: repl, forceMoveMarkers: true }]);
    me.focus();
  }

  // Applies one block. Editable diffs (right pane = working tree) edit the pane
  // directly, so it lands in the undo stack. A two-revision compare is read-only,
  // so it delegates to the backend splice via onApplyHunk (never edits the pane —
  // editing a read-only editor is what threw "Cannot edit in read-only editor").
  function applyHit(h: HunkInfo) {
    if (editable) revertHunk(h);
    else onApplyHunkRef.current?.(h.index);
  }

  function applyDecorations() {
    const diff = diffRef.current;
    const monaco = monacoRef.current;
    if (!diff || !monaco) return;
    const me = diff.getModifiedEditor();
    // Show the → glyph when a block can be applied: an editable working-tree diff,
    // or a read-only compare wired to apply into the working tree via the backend.
    const canApply = editable || !!onApplyHunkRef.current;
    const visible = canApply ? hunksRef.current : [];
    const decos = visible.map((h) => ({
      range: new monaco.Range(lineOf(h), 1, lineOf(h), 1),
      options: {
        glyphMarginClassName: "ff-revert-glyph",
        glyphMarginHoverMessage: { value: "Apply this change to the working tree" },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    decoRef.current = me.deltaDecorations(decoRef.current, decos);
  }

  useEffect(() => {
    hunksRef.current = hunks;
    applyDecorations();
  }, [hunks, targetSide]);

  function handleMount(diff: editor.IStandaloneDiffEditor, monaco: Monaco) {
    diffRef.current = diff;
    monacoRef.current = monaco;
    registerEditor(diff.getOriginalEditor());
    registerEditor(diff.getModifiedEditor());
    // Force layout — without it the original pane can mount at ~0 width.
    window.setTimeout(() => {
      diff.layout();
      reveal(0, false);
    }, 0);
    applyDecorations();

    // "Files are identical" placeholder. The diff computes async and recomputes
    // on every original/modified change, so track it off onDidUpdateDiff.
    const syncIdentical = () => setIdentical((diff.getLineChanges()?.length ?? 0) === 0);
    syncIdentical();
    diff.onDidUpdateDiff(syncIdentical);

    const me = diff.getModifiedEditor();
    // Replace lives on the active scheme's Mod key (⌘/Ctrl, or physical Alt under
    // the mac-on-PC swap) — not a hardcoded Ctrl — so it doesn't land on the same
    // physical key as diff.revertBlock and get shadowed by the global handler.
    const { mod } = monacoModifiers();
    const modFlag =
      mod === "Alt" ? monaco.KeyMod.Alt : mod === "WinCtrl" ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
    me.addCommand(modFlag | monaco.KeyCode.KeyR, () =>
      me.getAction("editor.action.startFindReplaceAction")?.run(),
    );
    me.onMouseDown((e) => {
      if (!editable && !onApplyHunkRef.current) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const ln = e.target.position.lineNumber;
        const hit = hunksRef.current.find((h) => lineOf(h) === ln);
        if (hit) applyHit(hit);
      }
    });

    if (editable) {
      let timer: number | undefined;
      me.onDidChangeModelContent(() => {
        const value = me.getValue();
        if (value === modifiedRef.current) return; // programmatic / no real change
        window.clearTimeout(timer);
        timer = window.setTimeout(() => onCommit?.(value), 350);
      });
    }
  }

  const hasLabels = !!(originalLabel || modifiedLabel);

  return (
    <div className="diff-shell">
    {hasLabels &&
      (inline ? (
        <div className="diff-pane-bar inline">
          <span className="dpb-cell" title={originalLabel}>
            <span className="dpb-ico" aria-hidden="true">⎇</span>
            <span className="dpb-ref">{originalLabel}</span>
            <span className="dpb-arrow" aria-hidden="true">→</span>
            <span className={`dpb-ico${modifiedWorking ? " work" : ""}`} aria-hidden="true">{modifiedWorking ? "✎" : "⎇"}</span>
            <span className="dpb-ref">{modifiedLabel}</span>
          </span>
        </div>
      ) : (
        <div className="diff-pane-bar" data-badge="→">
          <span className="dpb-cell" title={originalLabel}>
            <span className="dpb-ico" aria-hidden="true">⎇</span>
            <span className="dpb-ref">{originalLabel}</span>
          </span>
          <span className="dpb-cell" title={modifiedLabel}>
            <span className={`dpb-ico${modifiedWorking ? " work" : ""}`} aria-hidden="true">{modifiedWorking ? "✎" : "⎇"}</span>
            <span className="dpb-ref">{modifiedLabel}</span>
          </span>
        </div>
      ))}
    <MonacoDiff
      key={`${inline ? "inline" : "split"}-${editable ? "rw" : "ro"}`}
      // diff-wrap marks this as the *diff* editor so diff-scoped shortcuts
      // (undo/redo on Mod+Z) only fire here, not in the plain file editor — which
      // also carries editor-wrap and would otherwise have its Ctrl/⌘+Z stolen.
      className="editor-wrap diff-wrap"
      theme={monacoThemeId(prefs.theme)}
      language={language}
      original={original}
      modified={modified}
      beforeMount={(m) => {
        defineAllThemes(m);
        initPluginsForMonaco(m);
      }}
      onMount={handleMount}
      options={{
        readOnly: !editable,
        originalEditable: false,
        glyphMargin: true,
        // Single apply affordance = our own → glyph in the left gutter. Kill
        // BOTH of Monaco's: the old hover margin arrows (renderMarginRevertIcon)
        // and the new 0.52 gutter menu (renderGutterMenu) with its →/+ controls.
        renderMarginRevertIcon: false,
        renderGutterMenu: false,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: false,
        automaticLayout: true,
        lineHeight: 19,
        minimap: { enabled: false },
        renderOverviewRuler: false,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderLineHighlight: "none",
        padding: { top: 10, bottom: 10 },
        diffWordWrap: "off",
        ...editorPrefOptions(prefs),
      }}
    />
      {identical && <div className="diff-identical">Files are identical</div>}
    </div>
  );
});

export default DiffEditor;

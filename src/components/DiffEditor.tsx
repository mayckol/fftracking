import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { DiffEditor as MonacoDiff, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { HunkInfo } from "../lib/types";
import { defineTheme, THEME } from "./monacoTheme";

export interface DiffHandle {
  navigate: (dir: "next" | "prev") => void;
  focusFirst: () => void;
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
  /** Backend hunks; each gets an always-visible revert icon in the gutter. */
  hunks?: HunkInfo[];
  /** Which side the right/modified pane shows: false = current/working
   *  (hunk old_*), true = the target/point (hunk new_*). */
  targetSide?: boolean;
}

const DiffEditor = forwardRef<DiffHandle, Props>(function DiffEditor(
  { original, modified, language, inline = false, editable = false, onCommit, hunks = [], targetSide = false },
  ref,
) {
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const hunksRef = useRef<HunkInfo[]>(hunks);
  const decoRef = useRef<string[]>([]);
  const navRef = useRef(-1);

  function reveal(idx: number, focus: boolean) {
    const diff = diffRef.current;
    const changes = diff?.getLineChanges() ?? [];
    if (!diff || changes.length === 0) return;
    navRef.current = idx;
    const c = changes[idx];
    const line = c.modifiedStartLineNumber > 0 ? c.modifiedStartLineNumber : c.modifiedEndLineNumber || 1;
    const me = diff.getModifiedEditor();
    me.revealLineNearTop(line);
    me.setPosition({ lineNumber: line, column: 1 });
    if (focus) me.focus();
  }

  useImperativeHandle(ref, () => ({
    navigate(dir) {
      const changes = diffRef.current?.getLineChanges() ?? [];
      const n = changes.length;
      if (n === 0) return;
      reveal(dir === "next" ? (navRef.current + 1) % n : (navRef.current - 1 + n) % n, true);
    },
    focusFirst() {
      reveal(0, false);
    },
    revertCurrent() {
      const diff = diffRef.current;
      if (!diff || hunksRef.current.length === 0) return;
      const line = diff.getModifiedEditor().getPosition()?.lineNumber ?? 1;
      // The block whose start is nearest the cursor (so a keyboard revert acts on
      // the change you navigated to).
      const hit = hunksRef.current.reduce((best, h) =>
        Math.abs(lineOf(h) - line) < Math.abs(lineOf(best) - line) ? h : best,
      );
      revertHunk(hit);
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
  function lineOf(h: HunkInfo) {
    return Math.max(1, (targetSide ? h.new_start : h.old_start) + 1);
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

  function applyDecorations() {
    const diff = diffRef.current;
    const monaco = monacoRef.current;
    if (!diff || !monaco) return;
    const me = diff.getModifiedEditor();
    // The ⟲ block-revert only makes sense against the working tree (editable
    // "vs now"); in read-only "vs before" the panes are two past snapshots, so
    // show no revert glyphs there.
    const visible = editable ? hunksRef.current : [];
    const decos = visible.map((h) => ({
      range: new monaco.Range(lineOf(h), 1, lineOf(h), 1),
      options: {
        glyphMarginClassName: "ff-revert-glyph",
        glyphMarginHoverMessage: { value: "Revert this change to the selected point" },
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
    // Force layout — without it the original pane can mount at ~0 width.
    window.setTimeout(() => {
      diff.layout();
      reveal(0, false);
    }, 0);
    applyDecorations();

    const me = diff.getModifiedEditor();
    me.onMouseDown((e) => {
      if (!editable) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const ln = e.target.position.lineNumber;
        const hit = hunksRef.current.find((h) => lineOf(h) === ln);
        if (hit) revertHunk(hit);
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

  return (
    <MonacoDiff
      key={`${inline ? "inline" : "split"}-${editable ? "rw" : "ro"}`}
      className="editor-wrap"
      theme={THEME}
      language={language}
      original={original}
      modified={modified}
      beforeMount={defineTheme}
      onMount={handleMount}
      options={{
        readOnly: !editable,
        originalEditable: false,
        glyphMargin: true,
        // Our own always-visible glyph replaces Monaco's hover-only arrow.
        renderMarginRevertIcon: false,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: false,
        automaticLayout: true,
        fontFamily: "JetBrains Mono",
        fontSize: 12.5,
        lineHeight: 19,
        minimap: { enabled: false },
        renderOverviewRuler: false,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        guides: { indentation: false },
        renderLineHighlight: "none",
        padding: { top: 10, bottom: 10 },
        diffWordWrap: "off",
      }}
    />
  );
});

export default DiffEditor;

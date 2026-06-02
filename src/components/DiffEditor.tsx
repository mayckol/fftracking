import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { DiffEditor as MonacoDiff, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { HunkInfo } from "../lib/types";

export interface DiffHandle {
  navigate: (dir: "next" | "prev") => void;
}

const THEME = "fftrack-dark";

function defineTheme(monaco: Monaco) {
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5d6b7a", fontStyle: "italic" },
      { token: "keyword", foreground: "7c8cff" },
      { token: "string", foreground: "4cc4c0" },
      { token: "number", foreground: "e3b341" },
    ],
    colors: {
      "editor.background": "#0a0c10",
      "editor.foreground": "#e6edf3",
      "editorGutter.background": "#0a0c10",
      "editorLineNumber.foreground": "#3d4855",
      "editorLineNumber.activeForeground": "#9aa7b4",
      "editor.lineHighlightBackground": "#0e1116",
      "editor.selectionBackground": "#2b3744",
      "diffEditor.insertedTextBackground": "#3fb95022",
      "diffEditor.removedTextBackground": "#f0626e22",
      "diffEditor.insertedLineBackground": "#3fb95014",
      "diffEditor.removedLineBackground": "#f0626e14",
      "diffEditorGutter.insertedLineBackground": "#3fb95022",
      "diffEditorGutter.removedLineBackground": "#f0626e22",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#2b374488",
      "scrollbarSlider.hoverBackground": "#3a4756aa",
    },
  });
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
  onRevertHunk?: (index: number) => void;
  /** Which side the right/modified pane shows: false = current/working
   *  (hunk old_*), true = the target/point (hunk new_*). */
  targetSide?: boolean;
}

const DiffEditor = forwardRef<DiffHandle, Props>(function DiffEditor(
  { original, modified, language, inline = false, editable = false, onCommit, hunks = [], onRevertHunk, targetSide = false },
  ref,
) {
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const hunksRef = useRef<HunkInfo[]>(hunks);
  const decoRef = useRef<string[]>([]);
  const navRef = useRef(-1);

  useImperativeHandle(ref, () => ({
    navigate(dir) {
      const diff = diffRef.current;
      const changes = diff?.getLineChanges() ?? [];
      if (!diff || changes.length === 0) return;
      const n = changes.length;
      navRef.current = dir === "next" ? (navRef.current + 1) % n : (navRef.current - 1 + n) % n;
      const c = changes[navRef.current];
      const line = c.modifiedStartLineNumber > 0 ? c.modifiedStartLineNumber : c.modifiedEndLineNumber || 1;
      const me = diff.getModifiedEditor();
      me.revealLineNearTop(line);
      me.setPosition({ lineNumber: line, column: 1 });
      me.focus();
    },
  }));

  // Icon sits on the right/modified pane at the hunk start. old_* = current
  // (working) side, new_* = target (point) side — pick per which pane is shown.
  function lineOf(h: HunkInfo) {
    return Math.max(1, (targetSide ? h.new_start : h.old_start) + 1);
  }

  function applyDecorations() {
    const diff = diffRef.current;
    const monaco = monacoRef.current;
    if (!diff || !monaco) return;
    const me = diff.getModifiedEditor();
    const decos = hunksRef.current.map((h) => ({
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
    window.setTimeout(() => diff.layout(), 0);
    applyDecorations();

    const me = diff.getModifiedEditor();
    me.onMouseDown((e) => {
      if (!onRevertHunk) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const ln = e.target.position.lineNumber;
        const hit = hunksRef.current.find((h) => lineOf(h) === ln);
        if (hit) onRevertHunk(hit.index);
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

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Editor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MEditor } from "monaco-editor";
import { defineTheme, THEME } from "./monacoTheme";
import { attachGo } from "../lib/lsp";
import { comboFor } from "../lib/shortcuts";
import { editorPrefOptions, getPrefs, useUIPrefs } from "../lib/uiPrefs";

export interface FileHandle {
  reveal: (line: number, col: number) => void;
  getPosition: () => { line: number; col: number } | null;
}

// Parse a shortcut combo ("Mod+Shift+L", "F12") into a Monaco keybinding number.
function toKeybinding(monaco: Monaco, combo: string): number | null {
  let mods = 0;
  let key = "";
  for (const p of combo.split("+")) {
    if (p === "Mod") mods |= monaco.KeyMod.CtrlCmd;
    else if (p === "Shift") mods |= monaco.KeyMod.Shift;
    else if (p === "Alt") mods |= monaco.KeyMod.Alt;
    else if (p === "Ctrl") mods |= monaco.KeyMod.WinCtrl;
    else key = p;
  }
  const KC = monaco.KeyCode as unknown as Record<string, number>;
  let code: number | undefined;
  if (/^[a-z]$/i.test(key)) code = KC["Key" + key.toUpperCase()];
  else if (/^[0-9]$/.test(key)) code = KC["Digit" + key];
  else code = KC[key];
  return code == null ? null : mods | code;
}

interface Props {
  content: string;
  language: string;
  onSave?: (value: string) => void;
  // Absolute on-disk path + workspace root: enable the Go language server.
  path?: string;
  root?: string;
  // Jump to this 1-based position once mounted (cross-file go-to-definition).
  gotoPos?: { line: number; col: number };
  // External package files (stdlib / module cache) open read-only.
  readOnly?: boolean;
  // Fired on a plain left-click (not ⌘-click) so the host can log a nav point.
  onCursorClick?: (line: number, col: number) => void;
}

const LANG_LABEL: Record<string, string> = {
  go: "Go",
  rust: "Rust",
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  shell: "Shell",
  sql: "SQL",
  toml: "TOML",
};
function langLabel(id: string): string {
  return LANG_LABEL[id] ?? (id ? id[0].toUpperCase() + id.slice(1) : "Plain Text");
}

type LspState = "off" | "starting" | "ready" | "error";

const FileView = forwardRef<FileHandle, Props>(function FileView(
  { content, language, onSave, path, root, gotoPos, readOnly, onCursorClick },
  ref,
) {
  const prefs = useUIPrefs();
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [lsp, setLsp] = useState<LspState>("off");
  const [diag, setDiag] = useState({ errors: 0, warnings: 0 });
  const editorRef = useRef<MEditor.IStandaloneCodeEditor | null>(null);

  useImperativeHandle(ref, () => ({
    reveal(line, col) {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineNearTop(line);
      ed.setPosition({ lineNumber: line, column: col });
      ed.focus();
    },
    getPosition() {
      const p = editorRef.current?.getPosition();
      return p ? { line: p.lineNumber, col: p.column } : null;
    },
  }));

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // A plain left-click is a deliberate caret jump → log a nav point. ⌘-click
    // goes through go-to-definition, which records its own point.
    editor.onMouseDown((e) => {
      if (e.event.leftButton && !e.event.metaKey && !e.event.ctrlKey && e.target.position) {
        onCursorClick?.(e.target.position.lineNumber, e.target.position.column);
      }
    });

    const model = editor.getModel();
    const subs = [
      editor.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column })),
    ];

    if (model) {
      const recount = () => {
        const ms = monaco.editor.getModelMarkers({ resource: model.uri });
        let errors = 0;
        let warnings = 0;
        for (const m of ms) {
          if (m.severity === monaco.MarkerSeverity.Error) errors++;
          else if (m.severity === monaco.MarkerSeverity.Warning) warnings++;
        }
        setDiag({ errors, warnings });
      };
      subs.push(
        monaco.editor.onDidChangeMarkers((uris) => {
          if (uris.some((u) => u.toString() === model.uri.toString())) recount();
        }),
      );
      model.onWillDispose(() => subs.forEach((s) => s.dispose()));
    }

    const format = () => editor.getAction("editor.action.formatDocument")?.run();
    const bind = (id: string, fn: () => void) => {
      const kb = toKeybinding(monaco, comboFor(id));
      if (kb) editor.addCommand(kb, fn);
    };
    bind("editor.save", async () => {
      if (getPrefs().formatOnSave) await format();
      onSave?.(editor.getValue());
    });
    bind("editor.format", () => format());
    bind("editor.gotoDef", () => editor.getAction("editor.action.revealDefinition")?.run());

    if (language === "go" && path && root) {
      const model = editor.getModel();
      if (model) {
        setLsp("starting");
        attachGo({ monaco, model, root, path })
          .then(() => setLsp("ready"))
          .catch(() => setLsp("error"));
      }
    }

    // Content arrives async on (re)mount; reveal after it settles.
    if (gotoPos) {
      window.setTimeout(() => {
        editor.revealLineNearTop(gotoPos.line);
        editor.setPosition({ lineNumber: gotoPos.line, column: gotoPos.col });
        editor.focus();
      }, 220);
    }
  };

  const lspLabel: Record<LspState, string> = {
    off: "",
    starting: "gopls starting…",
    ready: "gopls ready",
    error: "gopls unavailable",
  };

  return (
    <div className="editor-shell">
      <Editor
        className="editor-wrap"
        theme={THEME}
        language={language}
        value={content}
        beforeMount={defineTheme}
        onMount={onMount}
        options={{
          readOnly: !!readOnly,
          glyphMargin: false,
          automaticLayout: true,
          lineHeight: 19,
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderLineHighlight: "all",
          ...editorPrefOptions(prefs),
        }}
      />
      <div className="statusbar">
        <span className="sb-lang">{langLabel(language)}</span>
        <span className="sb-diag" title={`${diag.errors} errors, ${diag.warnings} warnings`}>
          <span className={`sb-err${diag.errors > 0 ? " on" : ""}`}>⊘ {diag.errors}</span>
          <span className={`sb-warn${diag.warnings > 0 ? " on" : ""}`}>△ {diag.warnings}</span>
        </span>
        {lsp !== "off" && <span className={`sb-lsp ${lsp}`}>● {lspLabel[lsp]}</span>}
        <span className="sb-spacer" />
        <span className="sb-pos">
          Ln {pos.line}, Col {pos.col}
        </span>
      </div>
    </div>
  );
});

export default FileView;

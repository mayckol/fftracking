import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Editor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MEditor } from "monaco-editor";
import { defineTheme, THEME } from "./monacoTheme";
import {
  attachGo,
  implementationAnnotations,
  implementationLocations,
  openLocation,
  type ImplAnnotation,
  type ImplLocation,
} from "../lib/lsp";
import { registerEditor } from "../lib/selection";
import { comboFor, formatCombo } from "../lib/shortcuts";
import { editorPrefOptions, getPrefs, useUIPrefs } from "../lib/uiPrefs";

export interface FileHandle {
  reveal: (line: number, col: number) => void;
  getPosition: () => { line: number; col: number } | null;
}

// Monaco KeyCode names for punctuation keys as they appear in combo strings.
const PUNCT_KEY: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  "-": "Minus",
  "=": "Equal",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "\\": "Backslash",
  "`": "Backquote",
};

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
  else if (key in PUNCT_KEY) code = KC[PUNCT_KEY[key]];
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
  // Implementation-target picker (several results → JetBrains-style popup).
  const [implPick, setImplPick] = useState<{ x: number; y: number; locs: ImplLocation[] } | null>(null);
  const jumpToRef = useRef<(loc: ImplLocation) => void>(() => {});
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
    registerEditor(editor);

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

    const run = (action: string) => editor.getAction(action)?.run();
    bind("editor.duplicateLine", () => run("editor.action.copyLinesDownAction"));
    bind("editor.deleteWord", () => editor.trigger("ff", "deleteWordLeft", null));
    bind("editor.deleteLine", () => run("editor.action.deleteLines"));
    bind("editor.findNext", () => run("editor.action.nextMatchFindAction"));
    bind("editor.selectBlock", () => run("editor.action.selectToBracket"));
    bind("editor.jumpBracket", () => run("editor.action.jumpToBracket"));
    bind("editor.commentLine", () => run("editor.action.commentLine"));

    // Fold/unfold: one press acts on the block at the cursor; a quick second
    // press widens to the whole file.
    let lastFold = 0;
    let lastUnfold = 0;
    bind("editor.fold", () => {
      const now = performance.now();
      run(now - lastFold < 450 ? "editor.foldAll" : "editor.fold");
      lastFold = now;
    });
    bind("editor.unfold", () => {
      const now = performance.now();
      run(now - lastUnfold < 450 ? "editor.unfoldAll" : "editor.unfold");
      lastUnfold = now;
    });

    if (language === "go" && path && root) {
      const model = editor.getModel();
      if (model) {
        setLsp("starting");

        // JetBrains-style implementation markers: ↓ on interfaces / interface
        // methods that have implementations, ↑ on types / methods that satisfy
        // an interface. Click navigates (peek list when there are several).
        let implDecos: string[] = [];
        const implByLine = new Map<number, ImplAnnotation>();
        let implToken = 0;
        const annotate = async () => {
          const tok = ++implToken;
          const anns = await implementationAnnotations(model).catch(() => null);
          if (!anns || tok !== implToken || model.isDisposed()) return;
          implByLine.clear();
          for (const a of anns) implByLine.set(a.line, a);
          implDecos = editor.deltaDecorations(
            implDecos,
            anns.map((a) => ({
              range: new monaco.Range(a.line, 1, a.line, 1),
              options: {
                glyphMarginClassName: `impl-glyph ${a.kind === "impls" ? "impl-down" : "impl-up"}`,
                glyphMarginHoverMessage: {
                  value:
                    a.kind === "impls"
                      ? `**${a.count}** implementation${a.count === 1 ? "" : "s"} — click or press ${formatCombo(comboFor("editor.implementations"))} to navigate`
                      : `Implements **${a.count}** specification${a.count === 1 ? "" : "s"} — click or press ${formatCombo(comboFor("editor.implementations"))} to navigate`,
                },
              },
            })),
          );
        };
        let implTimer = 0;
        const queueAnnotate = () => {
          window.clearTimeout(implTimer);
          implTimer = window.setTimeout(annotate, 900);
        };
        model.onDidChangeContent(queueAnnotate);

        // Resolve targets straight from gopls and navigate ourselves — one
        // result jumps, several open the picker popup.
        const jumpTo = (loc: ImplLocation) => {
          if (loc.path === path) {
            editor.setPosition({ lineNumber: loc.line, column: loc.col });
            editor.revealLineNearTop(loc.line);
            editor.focus();
            onCursorClick?.(loc.line, loc.col);
          } else {
            openLocation(loc.path, loc.line, loc.col);
          }
        };
        jumpToRef.current = jumpTo;
        const showImplementations = async (line: number, col: number, x: number, y: number) => {
          const locs = await implementationLocations(model, line, col).catch(() => []);
          if (locs.length === 0) return;
          if (locs.length === 1) jumpTo(locs[0]);
          else setImplPick({ x, y, locs });
        };

        editor.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
          const a = e.target.position ? implByLine.get(e.target.position.lineNumber) : undefined;
          if (!a) return;
          e.event.preventDefault();
          const be = e.event.browserEvent;
          showImplementations(a.line, a.col, be.clientX, be.clientY);
        });
        bind("editor.implementations", () => {
          const p = editor.getPosition();
          if (!p) return;
          const vis = editor.getScrolledVisiblePosition(p);
          const r = editor.getDomNode()?.getBoundingClientRect();
          showImplementations(
            p.lineNumber,
            p.column,
            (r?.left ?? 0) + (vis?.left ?? 0),
            (r?.top ?? 0) + (vis?.top ?? 0) + (vis?.height ?? 18),
          );
        });

        attachGo({ monaco, model, root, path })
          .then(() => {
            setLsp("ready");
            // gopls type-checks the package in the background after didOpen —
            // an immediate probe sees nothing. Re-scan on a backoff until the
            // first batch lands (content edits keep it fresh afterwards).
            for (const delay of [600, 2500, 6000, 12000]) {
              window.setTimeout(() => {
                if (!model.isDisposed()) annotate();
              }, delay);
            }
          })
          .catch(() => setLsp("error"));

        // ⌘-hover affordance: underline + pointer on the word under the cursor
        // (the webview doesn't reliably show Monaco's own link style).
        let linkDeco: string[] = [];
        const clearLink = () => {
          if (linkDeco.length) linkDeco = editor.deltaDecorations(linkDeco, []);
        };
        editor.onMouseMove((e) => {
          const pos = e.target.position;
          if (
            (e.event.metaKey || e.event.ctrlKey) &&
            pos &&
            e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT
          ) {
            const word = editor.getModel()?.getWordAtPosition(pos);
            if (word) {
              linkDeco = editor.deltaDecorations(linkDeco, [
                {
                  range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
                  options: { inlineClassName: "goto-link-word" },
                },
              ]);
              return;
            }
          }
          clearLink();
        });
        // Releasing ⌘ (or leaving the editor) drops the link style.
        editor.onKeyUp(() => clearLink());
        editor.onMouseLeave(() => clearLink());
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
          // Implementation markers live in the glyph margin; only LSP-backed
          // files get one. Must be driven by state — this options object is
          // re-applied on every render, so a one-off updateOptions would be
          // silently reverted.
          glyphMargin: lsp === "ready",
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
      {implPick && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setImplPick(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setImplPick(null);
            }}
          />
          <div className="ctx-menu" style={{ left: implPick.x, top: implPick.y, maxHeight: 320, overflowY: "auto" }}>
            {implPick.locs.map((l, i) => (
              <button
                key={`${l.path}:${l.line}:${i}`}
                onClick={() => {
                  setImplPick(null);
                  jumpToRef.current(l);
                }}
              >
                {root && l.path.startsWith(`${root}/`) ? l.path.slice(root.length + 1) : l.path}:{l.line}
              </button>
            ))}
          </div>
        </>
      )}
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

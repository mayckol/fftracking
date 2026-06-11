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
import { runInTerminal } from "../lib/runner";
import { breakpointLines, subscribeBreakpoints, toggleBreakpoint } from "../lib/breakpoints";
import {
  getDebugSnapshot,
  registerDebugHover,
  startDebug,
  subscribeDebug,
  type LaunchConfig,
} from "../lib/debug";
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
  // Run/debug scope menu (test function / file / package / table case / main).
  const [testPick, setTestPick] = useState<{
    x: number;
    y: number;
    items: { label: string; cmd?: string; dbg?: LaunchConfig }[];
  } | null>(null);
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

    // JetBrains-style run-test icons on `func TestX` and table-driven
    // `t.Run("case", …)` lines. Click → scope menu; commands run in the
    // integrated terminal from the workspace root.
    if (language === "go" && path && root && path.endsWith("_test.go")) {
      const tmodel = editor.getModel();
      if (tmodel) {
        const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const pkg = rel.includes("/") ? `./${rel.slice(0, rel.lastIndexOf("/"))}` : ".";
        // go test renders subtest-name spaces as underscores; escape regex
        // metas and turn quotes into single-char wildcards for safe quoting.
        const caseRx = (s: string) =>
          s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "_").replace(/['"]/g, ".");

        interface TestMark {
          kind: "test" | "case" | "pkg";
          test: string;
          sub?: string;
        }
        const testByLine = new Map<number, TestMark>();
        let allTests: string[] = [];
        let testDecos: string[] = [];

        const scanTests = () => {
          testByLine.clear();
          allTests = [];
          let current: string | null = null;
          for (let i = 1; i <= tmodel.getLineCount(); i++) {
            const text = tmodel.getLineContent(i);
            if (/^package\s+[A-Za-z0-9_]+/.test(text)) {
              testByLine.set(i, { kind: "pkg", test: "" });
              continue;
            }
            const fm = /^func\s+(Test[A-Za-z0-9_]+)\s*\(/.exec(text);
            if (fm) {
              current = fm[1];
              allTests.push(fm[1]);
              testByLine.set(i, { kind: "test", test: fm[1] });
              continue;
            }
            if (/^func\s/.test(text)) {
              current = null;
              continue;
            }
            if (current) {
              // Explicit subtests, and table-driven entries by their name
              // field (the string t.Run(tt.name, …) will receive).
              const sm =
                /\bt\.Run\(\s*["`]([^"`]+)["`]/.exec(text) ??
                /^\s*(?:name|testName|desc|scenario)\s*:\s*["`]([^"`]+)["`]\s*,?\s*$/.exec(text);
              if (sm) testByLine.set(i, { kind: "case", test: current, sub: sm[1] });
            }
          }
          const hover = (m: TestMark) =>
            m.kind === "pkg"
              ? `Run package tests (**${pkg}**)`
              : m.kind === "case"
                ? `Run case **${m.sub}** (${formatCombo(comboFor("test.run"))})`
                : `Run **${m.test}** (${formatCombo(comboFor("test.run"))})`;
          testDecos = editor.deltaDecorations(
            testDecos,
            [...testByLine.entries()].map(([line, m]) => ({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: `test-glyph ${m.kind === "case" ? "test-case" : m.kind === "pkg" ? "test-pkg" : "test-fn"}`,
                glyphMarginHoverMessage: { value: hover(m) },
              },
            })),
          );
        };

        const cmdTest = (name: string) => `go test -v -run '^${name}$' ${pkg}`;
        const cmdCase = (m: TestMark) => `go test -v -run '^${m.test}$/^${caseRx(m.sub ?? "")}$' ${pkg}`;
        const cmdFile = () => `go test -v -run '^(${allTests.join("|")})$' ${pkg}`;
        const cmdPkg = `go test -v ${pkg}`;

        // Debug variants launch the same scope under delve (DAP test mode).
        const pkgAbs = path.slice(0, path.lastIndexOf("/"));
        const dbgTest = (label: string, pattern?: string): LaunchConfig => ({
          root,
          name: label,
          mode: "test",
          program: pkgAbs,
          args: pattern ? ["-test.run", pattern, "-test.v"] : ["-test.v"],
        });

        type MenuItem = { label: string; cmd?: string; dbg?: LaunchConfig };
        const menuFor = (m: TestMark): MenuItem[] => {
          if (m.kind === "pkg") {
            const items: MenuItem[] = [
              { label: `Run package tests (${pkg})`, cmd: cmdPkg },
              { label: `Debug package tests (${pkg})`, dbg: dbgTest(`Debug package tests (${pkg})`) },
            ];
            if (allTests.length) items.push({ label: "Run file tests", cmd: cmdFile() });
            return items;
          }
          const items: MenuItem[] =
            m.kind === "case"
              ? [
                  { label: `Run case "${m.sub}"`, cmd: cmdCase(m) },
                  {
                    label: `Debug case "${m.sub}"`,
                    dbg: dbgTest(`Debug case "${m.sub}"`, `^${m.test}$/^${caseRx(m.sub ?? "")}$`),
                  },
                  { label: `Run ${m.test}`, cmd: cmdTest(m.test) },
                ]
              : [
                  { label: `Run ${m.test}`, cmd: cmdTest(m.test) },
                  { label: `Debug ${m.test}`, dbg: dbgTest(`Debug ${m.test}`, `^${m.test}$`) },
                ];
          if (allTests.length > 1) items.push({ label: "Run file tests", cmd: cmdFile() });
          items.push({ label: `Run package tests (${pkg})`, cmd: cmdPkg });
          return items;
        };

        scanTests();
        let testTimer = 0;
        tmodel.onDidChangeContent(() => {
          window.clearTimeout(testTimer);
          testTimer = window.setTimeout(scanTests, 400);
        });

        editor.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
          const m = e.target.position ? testByLine.get(e.target.position.lineNumber) : undefined;
          if (!m) return;
          e.event.preventDefault();
          const be = e.event.browserEvent;
          setTestPick({ x: be.clientX, y: be.clientY, items: menuFor(m) });
        });

        // ^⇧R: run the nearest test context above the cursor, JetBrains-style —
        // a table case when inside one, else the enclosing test function.
        bind("test.run", () => {
          const line = editor.getPosition()?.lineNumber ?? 1;
          // Last mark at or above the cursor — the innermost test context
          // (map iterates in insertion order, i.e. ascending lines).
          let best: TestMark | null = null;
          for (const [l, m] of testByLine) {
            if (l > line) break;
            best = m;
          }
          if (best?.kind === "pkg") runInTerminal(cmdPkg);
          else if (best) runInTerminal(best.kind === "case" ? cmdCase(best) : cmdTest(best.test));
          else if (allTests.length) runInTerminal(cmdFile());
        });
      }
    }

    // JetBrains-style run/debug icon on `func main()` lines.
    if (language === "go" && path && root && !readOnly && !path.endsWith("_test.go")) {
      const mmodel = editor.getModel();
      if (mmodel) {
        const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const dir = rel.includes("/") ? `./${rel.slice(0, rel.lastIndexOf("/"))}` : ".";
        const pkgAbs = path.slice(0, path.lastIndexOf("/"));
        const mainLines = new Set<number>();
        let mainDecos: string[] = [];
        const scanMain = () => {
          mainLines.clear();
          for (let i = 1; i <= mmodel.getLineCount(); i++) {
            if (/^func main\s*\(/.test(mmodel.getLineContent(i))) mainLines.add(i);
          }
          mainDecos = editor.deltaDecorations(
            mainDecos,
            [...mainLines].map((line) => ({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: "test-glyph test-fn",
                glyphMarginHoverMessage: { value: `Run / debug **${dir}**` },
              },
            })),
          );
        };
        scanMain();
        let mainTimer = 0;
        mmodel.onDidChangeContent(() => {
          window.clearTimeout(mainTimer);
          mainTimer = window.setTimeout(scanMain, 400);
        });
        editor.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
          const line = e.target.position?.lineNumber;
          if (!line || !mainLines.has(line)) return;
          e.event.preventDefault();
          const be = e.event.browserEvent;
          setTestPick({
            x: be.clientX,
            y: be.clientY,
            items: [
              { label: `Run ${dir}`, cmd: `go run ${dir}` },
              { label: `Debug ${dir}`, dbg: { root, name: `Debug ${dir}`, mode: "debug", program: pkgAbs } },
            ],
          });
        });
      }
    }

    // Breakpoints: click the line-number gutter (or empty glyph margin) to
    // toggle; while paused, the current execution line is highlighted.
    if (language === "go" && path && root && !readOnly) {
      const bmodel = editor.getModel();
      if (bmodel) {
        let bpDecos: string[] = [];
        const renderBps = () => {
          const max = bmodel.getLineCount();
          bpDecos = editor.deltaDecorations(
            bpDecos,
            [...breakpointLines(path)]
              .filter((l) => l <= max)
              .map((line) => ({
                range: new monaco.Range(line, 1, line, 1),
                options: {
                  glyphMarginClassName: "bp-glyph",
                  glyphMarginHoverMessage: { value: "Breakpoint — click to remove" },
                },
              })),
          );
        };
        renderBps();
        const unsubBp = subscribeBreakpoints((p) => {
          if (p === path && !bmodel.isDisposed()) renderBps();
        });

        editor.onMouseDown((e) => {
          const MT = monaco.editor.MouseTargetType;
          if (e.target.type !== MT.GUTTER_GLYPH_MARGIN && e.target.type !== MT.GUTTER_LINE_NUMBERS) return;
          if (e.target.type === MT.GUTTER_GLYPH_MARGIN) {
            // Lines whose glyph slot is owned by a run/impl marker keep their
            // click behaviour; breakpoints go on the line-number gutter there.
            const cls = (e.target.element as HTMLElement | null)?.classList;
            if (cls && (cls.contains("test-glyph") || cls.contains("impl-glyph"))) return;
          }
          const line = e.target.position?.lineNumber;
          if (!line) return;
          e.event.preventDefault();
          toggleBreakpoint(path, line);
        });
        bind("debug.toggleBreakpoint", () => {
          const line = editor.getPosition()?.lineNumber;
          if (line) toggleBreakpoint(path, line);
        });

        registerDebugHover(monaco);

        // JetBrains-style inline values: each local/argument is annotated at
        // its last mention at-or-above the execution line.
        const fmtVal = (v: string) => {
          const flat = v.replace(/\s+/g, " ").trim();
          return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
        };
        const inlineValueDecos = (f: { line: number }, vars: { name: string; value: string }[]) => {
          const byLine = new Map<number, string[]>();
          const from = Math.max(1, f.line - 150);
          for (const v of vars.slice(0, 80)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) continue;
            const rx = new RegExp(`\\b${v.name}\\b`);
            for (let ln = f.line; ln >= from; ln--) {
              if (!rx.test(bmodel.getLineContent(ln))) continue;
              const list = byLine.get(ln) ?? [];
              list.push(`${v.name} = ${fmtVal(v.value)}`);
              byLine.set(ln, list);
              break;
            }
          }
          return [...byLine.entries()].map(([ln, parts]) => {
            const col = bmodel.getLineMaxColumn(ln);
            return {
              range: new monaco.Range(ln, col, ln, col),
              options: {
                after: { content: `   ${parts.join("   ")}`, inlineClassName: "debug-inline-val" },
              },
            };
          });
        };

        let execDecos: string[] = [];
        const renderExec = () => {
          const s = getDebugSnapshot();
          const f = s.currentFrame;
          if (s.status === "paused" && f?.path === path && f.line > 0 && f.line <= bmodel.getLineCount()) {
            execDecos = editor.deltaDecorations(execDecos, [
              {
                range: new monaco.Range(f.line, 1, f.line, 1),
                options: {
                  isWholeLine: true,
                  className: "debug-exec-line",
                  glyphMarginClassName: "debug-exec-glyph",
                },
              },
              ...inlineValueDecos(f, s.frameVars),
            ]);
            editor.revealLineInCenterIfOutsideViewport(f.line);
          } else if (execDecos.length) {
            execDecos = editor.deltaDecorations(execDecos, []);
          }
        };
        renderExec();
        const unsubDbg = subscribeDebug(renderExec);
        bmodel.onWillDispose(() => {
          unsubBp();
          unsubDbg();
        });
      }
    }

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
          // Go files own the glyph margin: implementation markers (LSP) and
          // test-run icons live there. Kept in this options object — it is
          // re-applied on every render, so a one-off updateOptions would be
          // silently reverted.
          glyphMargin: language === "go",
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
      {testPick && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setTestPick(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTestPick(null);
            }}
          />
          <div className="ctx-menu" style={{ left: testPick.x, top: testPick.y }}>
            {testPick.items.map((it) => (
              <button
                key={it.label}
                title={it.cmd ?? it.dbg?.name}
                onClick={() => {
                  setTestPick(null);
                  if (it.cmd) runInTerminal(it.cmd);
                  else if (it.dbg) startDebug(it.dbg).catch(() => {});
                }}
              >
                {it.dbg ? "🐞" : "▶"} {it.label}
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

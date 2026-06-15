import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Editor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MEditor } from "monaco-editor";
import { defineAllThemes, monacoThemeId } from "./monacoTheme";
import { initPluginsForMonaco } from "../lib/plugins/registry";
import {
  attachGo,
  implementationAnnotations,
  implementationLocations,
  openLocation,
  organizeImports,
  restartLsp,
  subscribeLspState,
  workspaceInterfaces,
  type IfaceSymbol,
  type ImplAnnotation,
  type ImplLocation,
} from "../lib/lsp";
import { buildStubs, packageNameOf } from "../lib/implement";
import { applyImportGrouping, cachedGoImportsConfig, importPlanner } from "../lib/goimports";
import { registerEditor } from "../lib/selection";
import { startRun, type RunSpec } from "../lib/run";
import { breakpointLines, subscribeBreakpoints, toggleBreakpoint } from "../lib/breakpoints";
import {
  getDebugSnapshot,
  registerDebugHover,
  startDebug,
  subscribeDebug,
  type LaunchConfig,
} from "../lib/debug";
import { comboFor, formatCombo, IS_MAC, monacoModifiers } from "../lib/shortcuts";
import { resetZoom, useZoomLevel, zoomPercent } from "../lib/editorZoom";
import { editorPrefOptions, getPrefs, useUIPrefs } from "../lib/uiPrefs";
import { api } from "../lib/ipc";
import MarkdownPreview from "./MarkdownPreview";
import Splitter from "./Splitter";
import { getMdSplit, useMdSplit, useMdViewMode } from "../lib/mdViewMode";
import type { HunkInfo } from "../lib/types";

export interface FileHandle {
  reveal: (line: number, col: number) => void;
  getPosition: () => { line: number; col: number } | null;
}

// A gutter run/debug menu entry: either runs in the Run panel or launches under
// the debugger.
type RunMenuItem = { label: string; run?: RunSpec; dbg?: LaunchConfig };

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

// Combo arrow names (from key events) → Monaco KeyCode enum names.
const ARROW_KEY: Record<string, string> = {
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
};

// Parse a shortcut combo ("Mod+Shift+L", "F12") into a Monaco keybinding number.
function toKeybinding(monaco: Monaco, combo: string): number | null {
  // The active keymap style decides which physical Monaco modifier the logical
  // Mod / Alt tokens bind to (the swap maps Mod→Alt, Alt→WinCtrl on a PC).
  const { mod, alt } = monacoModifiers();
  const modFlag =
    mod === "Alt" ? monaco.KeyMod.Alt : mod === "WinCtrl" ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
  const altFlag = alt === "WinCtrl" ? monaco.KeyMod.WinCtrl : monaco.KeyMod.Alt;
  let mods = 0;
  let key = "";
  for (const p of combo.split("+")) {
    if (p === "Mod") mods |= modFlag;
    else if (p === "Shift") mods |= monaco.KeyMod.Shift;
    else if (p === "Alt") mods |= altFlag;
    else if (p === "Ctrl") mods |= monaco.KeyMod.WinCtrl;
    else key = p;
  }
  const KC = monaco.KeyCode as unknown as Record<string, number>;
  let code: number | undefined;
  if (/^[a-z]$/i.test(key)) code = KC["Key" + key.toUpperCase()];
  else if (/^[0-9]$/.test(key)) code = KC["Digit" + key];
  else if (key in PUNCT_KEY) code = KC[PUNCT_KEY[key]];
  else if (key in ARROW_KEY) code = KC[ARROW_KEY[key]];
  else code = KC[key];
  return code == null ? null : mods | code;
}

interface Props {
  content: string;
  language: string;
  // `auto` is true for debounced auto-saves so the host can skip the toast.
  onSave?: (value: string, auto: boolean) => void | Promise<void>;
  // Reports whether the editor content differs from what's on disk, so the host
  // can show an unsaved-changes dot in the tab.
  onDirtyChange?: (dirty: boolean) => void;
  // Absolute on-disk path + workspace root: enable the Go language server.
  path?: string;
  root?: string;
  // Jump to this 1-based position once mounted (cross-file go-to-definition).
  gotoPos?: { line: number; col: number };
  // External package files (stdlib / module cache) open read-only.
  readOnly?: boolean;
  // Fired on a plain left-click (not ⌘-click) so the host can log a nav point.
  onCursorClick?: (line: number, col: number) => void;
  // Baseline text for the VCS-style gutter (git HEAD or the latest breaking
  // point). Lines differing from it get colored change stripes; clicking a
  // stripe opens a JetBrains-style popup with the old block + rollback/copy.
  // undefined = feature off (still loading, external file).
  diffBase?: string | null;
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

function MdIcon({ kind }: { kind: "raw" | "both" | "read" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      {kind === "raw" && (
        <>
          <path d="M6 5 3 8l3 3M10 5l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "both" && (
        <>
          <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 3v10" stroke="currentColor" strokeWidth="1.2" />
        </>
      )}
      {kind === "read" && (
        <>
          <path d="M2.5 4h11M2.5 7h11M2.5 10h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

const FileView = forwardRef<FileHandle, Props>(function FileView(
  { content, language, onSave, onDirtyChange, path, root, gotoPos, readOnly, onCursorClick, diffBase },
  ref,
) {
  const prefs = useUIPrefs();
  const zoomLevel = useZoomLevel();
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [lsp, setLsp] = useState<LspState>("off");
  const isMarkdown = language === "markdown";
  const [mdMode, setMdMode] = useMdViewMode();
  const [mdSplit, setMdSplit] = useMdSplit();
  const [mdSource, setMdSource] = useState(content);
  const mdBodyRef = useRef<HTMLDivElement>(null);

  // Reflect restarts triggered elsewhere (command palette) for this root.
  useEffect(() => {
    if (language !== "go" || !root) return;
    return subscribeLspState((r, phase) => {
      if (r === root) setLsp(phase);
    });
  }, [language, root]);
  // Implementation-target picker (several results → JetBrains-style popup).
  const [implPick, setImplPick] = useState<{ x: number; y: number; locs: ImplLocation[] } | null>(null);
  const jumpToRef = useRef<(loc: ImplLocation) => void>(() => {});
  // Run/debug scope menu (test function / file / package / table case / main).
  const [testPick, setTestPick] = useState<{
    x: number;
    y: number;
    items: RunMenuItem[];
  } | null>(null);
  const [diag, setDiag] = useState({ errors: 0, warnings: 0 });
  const editorRef = useRef<MEditor.IStandaloneCodeEditor | null>(null);
  // Last text known to be on disk; dirty = editor value differs from this.
  const savedValueRef = useRef(content);
  // Props change identity across renders; onMount captures them once, so read
  // the live versions through refs (auto-save fires long after mount).
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;

  // VCS-style gutter change stripes vs `diffBase`. Hunk sides: old_* indexes
  // the editor content, new_* the baseline (text_hunks swaps its args).
  const [gutPop, setGutPop] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [gutHunks, setGutHunks] = useState<HunkInfo[]>([]);
  const [oldHtml, setOldHtml] = useState("");
  const diffBaseRef = useRef(diffBase);
  diffBaseRef.current = diffBase;
  const recomputeRef = useRef<() => void>(() => {});
  const gutCtlRef = useRef<{
    goto: (idx: number) => void;
    rollback: (h: HunkInfo) => void;
    checkout: () => void;
  }>({
    goto: () => {},
    rollback: () => {},
    checkout: () => {},
  });
  const monacoApiRef = useRef<Monaco | null>(null);

  useEffect(() => {
    setGutPop(null);
    recomputeRef.current();
  }, [diffBase]);

  // Implement-interface picker (Ctrl+I, JetBrains-style): search gopls's
  // workspace symbols, pick an interface, name the type, insert stubs.
  const [ifaceGen, setIfaceGen] = useState<{
    x: number;
    y: number;
    step: "search" | "name";
    query: string;
    nonProject: boolean;
    results: IfaceSymbol[];
    sel: number;
    iface?: IfaceSymbol;
    typeName: string;
    busy: boolean;
  } | null>(null);
  const ifaceInsertRef = useRef<(iface: IfaceSymbol, typeName: string) => Promise<void>>(async () => {});

  useEffect(() => {
    if (!ifaceGen || ifaceGen.step !== "search") return;
    const m = editorRef.current?.getModel();
    if (!m) return;
    const { query, nonProject } = ifaceGen;
    let alive = true;
    const t = window.setTimeout(async () => {
      const all = await workspaceInterfaces(m, query).catch(() => []);
      if (!alive) return;
      const prefix = root ? (root.endsWith("/") ? root : `${root}/`) : "";
      const scoped = nonProject || !prefix ? all : all.filter((s) => s.path.startsWith(prefix));
      // Project results first; gopls's own ranking within each group.
      const inProj = (s: IfaceSymbol) => (prefix && s.path.startsWith(prefix) ? 0 : 1);
      scoped.sort((a, b) => inProj(a) - inProj(b));
      setIfaceGen((cur) =>
        cur && cur.step === "search" && cur.query === query && cur.nonProject === nonProject
          ? { ...cur, results: scoped.slice(0, 50), sel: 0 }
          : cur,
      );
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ifaceGen?.step, ifaceGen?.query, ifaceGen?.nonProject, root]);

  // Previous block of the hunk under the popup, syntax-colored with Monaco's
  // tokenizer so it reads like the editor.
  const popHunk = gutPop ? gutHunks[gutPop.idx] : undefined;
  const popOldText =
    popHunk && diffBase != null && popHunk.new_len > 0
      ? diffBase
          .split("\n")
          .slice(popHunk.new_start, popHunk.new_start + popHunk.new_len)
          .join("\n")
      : "";
  useEffect(() => {
    if (!popOldText || !monacoApiRef.current) {
      setOldHtml("");
      return;
    }
    let alive = true;
    monacoApiRef.current.editor
      .colorize(popOldText, language, { tabSize: 4 })
      .then((h) => alive && setOldHtml(h))
      .catch(() => alive && setOldHtml(""));
    return () => {
      alive = false;
    };
  }, [popOldText, language]);

  // External reload of the open file (snapshot restore, git ops): the editor
  // is uncontrolled (defaultValue), so push the new text in ourselves.
  // setValue also resets that file's undo stack — correct for a disk reload.
  // Skipped on mount: the model already holds the right content, and a kept
  // model may carry unsaved edits we must not wipe.
  const firstContent = useRef(true);
  useEffect(() => {
    if (firstContent.current) {
      firstContent.current = false;
      return;
    }
    const m = editorRef.current?.getModel();
    if (m && m.getValue() !== content) m.setValue(content);
    // The new content is now the on-disk baseline (save succeeded, or a reload).
    savedValueRef.current = content;
    onDirtyRef.current?.(false);
  }, [content]);

  // Showing the editor again after Read mode hid it (display:none) can leave
  // Monaco with stale dimensions until the next resize — force a relayout.
  useEffect(() => {
    if (isMarkdown && mdMode !== "read") editorRef.current?.layout();
  }, [mdMode, isMarkdown, mdSplit]);

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

    // Modifier + mouse wheel jumps to the top / bottom of the file: ⌘ on macOS,
    // Alt elsewhere — ⌘/Ctrl + wheel is Monaco's zoom gesture, so the free
    // modifier differs per platform. Capture phase + passive:false so the jump
    // wins over the editor's normal scroll.
    const dom = editor.getDomNode();
    if (dom) {
      const onWheel = (e: WheelEvent) => {
        if (!(IS_MAC ? e.metaKey : e.altKey) || e.deltaY === 0) return;
        e.preventDefault();
        e.stopPropagation();
        editor.trigger("ff", e.deltaY < 0 ? "cursorTop" : "cursorBottom", null);
      };
      dom.addEventListener("wheel", onWheel, { passive: false, capture: true });
      editor.onDidDispose(() => dom.removeEventListener("wheel", onWheel, { capture: true }));
    }

    const model = editor.getModel();
    const subs = [
      editor.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column })),
    ];

    // Feed live source into the Markdown preview (the model is uncontrolled, so
    // `content` only reflects the initial value).
    if (isMarkdown && model) {
      setMdSource(model.getValue());
      const sub = model.onDidChangeContent(() => setMdSource(model.getValue()));
      editor.onDidDispose(() => sub.dispose());
    }

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
      // Models now outlive the editor (kept per path for undo history), so
      // tie listener cleanup to the editor instance instead.
      editor.onDidDispose(() => subs.forEach((s) => s.dispose()));
    }

    // JetBrains-style reformat: gopls fixes missing/unused imports, the
    // grouping pass reorders the block per the chosen style, then gofmt runs
    // over the result.
    const groupImports = async () => {
      const m = editor.getModel();
      if (m && language === "go" && root && getPrefs().goImportsOnSave)
        await applyImportGrouping(m, root, getPrefs().goImportStyle);
    };
    const format = async () => {
      const m = editor.getModel();
      if (m && language === "go") await organizeImports(m);
      await groupImports();
      await editor.getAction("editor.action.formatDocument")?.run();
    };
    const bind = (id: string, fn: () => void) => {
      const kb = toKeybinding(monaco, comboFor(id));
      if (kb) editor.addCommand(kb, fn);
    };
    // Manual save formats / regroups imports per prefs; auto-save just writes
    // the current text so it never reformats mid-thought. Either way the saved
    // baseline advances and the tab's dirty dot clears.
    const doSave = async (auto: boolean) => {
      if (!auto) {
        if (getPrefs().formatOnSave) await format();
        else await groupImports();
      }
      const v = editor.getValue();
      await onSaveRef.current?.(v, auto);
      savedValueRef.current = v;
      onDirtyRef.current?.(false);
    };
    bind("editor.save", () => void doSave(false));
    bind("editor.format", () => format());
    bind("editor.gotoDef", () => editor.getAction("editor.action.revealDefinition")?.run());

    const run = (action: string) => editor.getAction(action)?.run();
    const dupLine = () => run("editor.action.copyLinesDownAction");
    bind("editor.duplicateLine", dupLine);
    // On a Mac ⌘D duplicates too (the canonical Alt+D binding covers ⌥D); the
    // physical Ctrl key is reserved for delete-line, so only add this when ⌘ is
    // actually the Mod key (native / mac style on a real Mac).
    if (IS_MAC && monacoModifiers().mod === "CtrlCmd") {
      const kb = toKeybinding(monaco, "Mod+D");
      if (kb) editor.addCommand(kb, dupLine);
    }
    bind("editor.deleteWord", () => editor.trigger("ff", "deleteWordLeft", null));
    bind("editor.deleteLine", () => run("editor.action.deleteLines"));
    bind("editor.gotoLine", () => run("editor.action.gotoLine"));
    bind("editor.selectAll", () => run("editor.action.selectAll"));
    bind("editor.gotoLineEnd", () => editor.trigger("ff", "cursorEnd", null));

    // Unsaved-changes dot + intelligent auto-save (editable files only). Dirty
    // is recomputed shortly after edits stop; auto-save writes ~1s after the
    // last keystroke when enabled. A kept model may reopen carrying edits, so
    // sync once on mount too.
    const dmodel = editor.getModel();
    if (dmodel && !readOnly) {
      const syncDirty = () => onDirtyRef.current?.(dmodel.getValue() !== savedValueRef.current);
      syncDirty();
      let dirtyTimer = 0;
      let autoTimer = 0;
      const sub = dmodel.onDidChangeContent(() => {
        window.clearTimeout(dirtyTimer);
        dirtyTimer = window.setTimeout(syncDirty, 200);
        if (getPrefs().autoSave) {
          window.clearTimeout(autoTimer);
          autoTimer = window.setTimeout(() => {
            if (dmodel.getValue() !== savedValueRef.current) void doSave(true);
          }, 1000);
        }
      });
      editor.onDidDispose(() => {
        sub.dispose();
        window.clearTimeout(dirtyTimer);
        window.clearTimeout(autoTimer);
      });
    }
    // Opens the find widget with the replace row expanded; if find is already
    // open (find-only), it widens it to show replace.
    bind("editor.replace", () => run("editor.action.startFindReplaceAction"));
    bind("editor.expandSelection", () => run("editor.action.smartSelect.expand"));
    bind("editor.shrinkSelection", () => run("editor.action.smartSelect.shrink"));
    bind("editor.jumpBracket", () => run("editor.action.jumpToBracket"));
    bind("editor.commentLine", () => run("editor.action.commentLine"));
    bind("editor.gotoFileStart", () => editor.trigger("ff", "cursorTop", null));
    bind("editor.gotoFileEnd", () => editor.trigger("ff", "cursorBottom", null));

    // Fold/unfold (⌘⇧±) and zoom (⌘±, ⌘0) are bound globally in App via the
    // shortcut registry — not here — so the numpad +/-/− keys work too.

    // Under the mac-on-PC swap the ⌘ key is physically Alt, so Monaco's built-in
    // editing shortcuts (still on physical Ctrl) wouldn't answer to ⌘C/⌘V/…
    // Bind the common set onto the ⌘ key too; physical Ctrl keeps working as a
    // documented fallback.
    if (monacoModifiers().mod === "Alt") {
      const addCmd = (combo: string, fn: () => void) => {
        const kb = toKeybinding(monaco, combo);
        if (kb) editor.addCommand(kb, fn);
      };
      addCmd("Mod+C", () => run("editor.action.clipboardCopyAction"));
      addCmd("Mod+X", () => run("editor.action.clipboardCutAction"));
      addCmd("Mod+V", () => run("editor.action.clipboardPasteAction"));
      addCmd("Mod+Z", () => editor.trigger("ff", "undo", null));
      addCmd("Mod+Shift+Z", () => editor.trigger("ff", "redo", null));
      // Monaco's find sits on physical Ctrl; map it onto ⌘ too so ⌘F (⌥F here)
      // opens the find widget. Next/prev stay on F3 / Enter inside the widget.
      addCmd("Mod+F", () => run("actions.find"));
    }

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

        // Tests run via the Run panel (lib/run), not the terminal — argv form
        // so patterns need no shell quoting.
        const goTest = (label: string, runArg?: string): RunSpec => ({
          cwd: root,
          label,
          program: "go",
          args: runArg ? ["test", "-v", "-run", runArg, pkg] : ["test", "-v", pkg],
        });
        const specTest = (name: string) => goTest(`go test -run ^${name}$ ${pkg}`, `^${name}$`);
        const specCase = (m: TestMark) =>
          goTest(`go test -run ${m.test}/${m.sub} ${pkg}`, `^${m.test}$/^${caseRx(m.sub ?? "")}$`);
        const specFile = () => goTest(`go test (file) ${pkg}`, `^(${allTests.join("|")})$`);
        const specPkg = goTest(`go test ${pkg}`);

        // Debug variants launch the same scope under delve (DAP test mode).
        const pkgAbs = path.slice(0, path.lastIndexOf("/"));
        const dbgTest = (label: string, pattern?: string): LaunchConfig => ({
          root,
          name: label,
          mode: "test",
          program: pkgAbs,
          args: pattern ? ["-test.run", pattern, "-test.v"] : ["-test.v"],
        });

        const menuFor = (m: TestMark): RunMenuItem[] => {
          if (m.kind === "pkg") {
            const items: RunMenuItem[] = [
              { label: `Run package tests (${pkg})`, run: specPkg },
              { label: `Debug package tests (${pkg})`, dbg: dbgTest(`Debug package tests (${pkg})`) },
            ];
            if (allTests.length) items.push({ label: "Run file tests", run: specFile() });
            return items;
          }
          const items: RunMenuItem[] =
            m.kind === "case"
              ? [
                  { label: `Run case "${m.sub}"`, run: specCase(m) },
                  {
                    label: `Debug case "${m.sub}"`,
                    dbg: dbgTest(`Debug case "${m.sub}"`, `^${m.test}$/^${caseRx(m.sub ?? "")}$`),
                  },
                  { label: `Run ${m.test}`, run: specTest(m.test) },
                ]
              : [
                  { label: `Run ${m.test}`, run: specTest(m.test) },
                  { label: `Debug ${m.test}`, dbg: dbgTest(`Debug ${m.test}`, `^${m.test}$`) },
                ];
          if (allTests.length > 1) items.push({ label: "Run file tests", run: specFile() });
          items.push({ label: `Run package tests (${pkg})`, run: specPkg });
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
          if (best?.kind === "pkg") startRun(specPkg);
          else if (best) startRun(best.kind === "case" ? specCase(best) : specTest(best.test));
          else if (allTests.length) startRun(specFile());
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
              { label: `Run ${dir}`, run: { cwd: root, label: `go run ${dir}`, program: "go", args: ["run", dir] } },
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

        // Implement interface (Ctrl+I): picker at the caret. When the caret
        // sits on a `type X …` declaration the stubs target that type;
        // otherwise a new type is created.
        bind("editor.implementIface", () => {
          if (readOnly) return;
          const p = editor.getPosition();
          if (!p) return;
          const vis = editor.getScrolledVisiblePosition(p);
          const r = editor.getDomNode()?.getBoundingClientRect();
          const onType = /^type\s+([A-Za-z_]\w*)/.exec(model.getLineContent(p.lineNumber));
          setIfaceGen({
            x: (r?.left ?? 0) + (vis?.left ?? 0),
            y: (r?.top ?? 0) + (vis?.top ?? 0) + (vis?.height ?? 18),
            step: "search",
            query: "",
            nonProject: true,
            results: [],
            sel: 0,
            typeName: onType?.[1] ?? "",
            busy: false,
          });
        });

        ifaceInsertRef.current = async (iface, typeName) => {
          const src = await api.readTextFile(iface.path).catch(() => null);
          if (src == null || model.isDisposed()) {
            setIfaceGen(null);
            return;
          }
          const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
          const qualifier = dirOf(iface.path) === dirOf(path) ? "" : packageNameOf(src);
          // The type may already exist in this file — then only methods go in.
          const exists = new RegExp(`^type\\s+${typeName}\\b`, "m").test(model.getValue());
          const stub = buildStubs({
            source: src,
            ifaceName: iface.name,
            line: iface.line,
            typeName,
            qualifier,
            ifacePkgPath: iface.pkgPath,
            createType: !exists,
          });
          setIfaceGen(null);
          if (!stub) return;
          // Plan the imports the signatures reference (resolved through the
          // interface file's import block — deterministic, unlike waiting for
          // gopls to digest the change). The planner binds each path to a
          // qualifier (existing alias, or the canonical package name for a
          // fresh plain import) — rewrite the stub to whatever it bound.
          const plan = importPlanner(model, cachedGoImportsConfig(root), getPrefs().goImportStyle);
          let text = stub.text;
          const importEdits: MEditor.IIdentifiedSingleEditOperation[] = [];
          for (const imp of stub.imports) {
            const p = plan(imp.path, imp.name);
            if (!p) continue;
            if (p.qualifier !== imp.pkg) {
              text = text.replace(new RegExp(`\\b${imp.pkg}\\.`, "g"), p.qualifier ? `${p.qualifier}.` : "");
            }
            if (p.edit) importEdits.push({ range: p.edit.range, text: p.edit.text, forceMoveMarkers: true });
          }
          const ln = editor.getPosition()?.lineNumber ?? model.getLineCount();
          const col = model.getLineMaxColumn(ln);
          // Stub goes in first — it sits below the import block, so the import
          // inserts (planned against the pre-stub layout) stay valid either way.
          editor.executeEdits("ff-implement", [
            { range: new monaco.Range(ln, col, ln, col), text: `\n\n${text}`, forceMoveMarkers: true },
          ]);
          if (importEdits.length) editor.executeEdits("ff-implement-imports", importEdits);
          // gopls catches anything left (and drops nothing we just added), gofmt tidies.
          await organizeImports(model);
          await editor.getAction("editor.action.formatDocument")?.run();
          editor.focus();
        };

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

    // JetBrains-style VCS gutter: stripes on lines that differ from the
    // baseline; click → popup with the old block, rollback and navigation.
    monacoApiRef.current = monaco;
    if (model) {
      const gmodel = model;
      // Stripe anchor line (1-based, editor side). Pure deletions sit between
      // two lines — anchor on the line above the gap.
      const hunkLine = (h: HunkInfo) => (h.old_len > 0 ? h.old_start + 1 : Math.max(1, h.old_start));
      const hunkCovers = (h: HunkInfo, line: number) =>
        h.old_len > 0 ? line >= h.old_start + 1 && line <= h.old_start + h.old_len : line === hunkLine(h);

      let changeDecos: string[] = [];
      const renderChanges = (hk: HunkInfo[]) => {
        changeDecos = editor.deltaDecorations(
          changeDecos,
          hk.map((h) => ({
            range: new monaco.Range(hunkLine(h), 1, h.old_len > 0 ? h.old_start + h.old_len : hunkLine(h), 1),
            options: {
              linesDecorationsClassName: `ff-gut-change ${h.new_len === 0 ? "add" : h.old_len === 0 ? "del" : "mod"}`,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          })),
        );
      };

      const hunksRef = { current: [] as HunkInfo[] };
      let gutToken = 0;
      const recompute = async () => {
        const base = diffBaseRef.current;
        if (base == null || gmodel.isDisposed()) {
          hunksRef.current = [];
          setGutHunks([]);
          if (!gmodel.isDisposed()) renderChanges([]);
          return;
        }
        const tok = ++gutToken;
        const hk = await api.textHunks(base, gmodel.getValue()).catch(() => null);
        if (!hk || tok !== gutToken || gmodel.isDisposed()) return;
        hunksRef.current = hk;
        setGutHunks(hk);
        renderChanges(hk);
      };
      recomputeRef.current = recompute;
      recompute();
      let gutTimer = 0;
      const gutSub = gmodel.onDidChangeContent(() => {
        window.clearTimeout(gutTimer);
        gutTimer = window.setTimeout(recompute, 350);
      });
      editor.onDidDispose(() => gutSub.dispose());

      editor.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
        if (!(e.target.element as HTMLElement | null)?.classList.contains("ff-gut-change")) return;
        const line = e.target.position?.lineNumber;
        if (!line) return;
        const idx = hunksRef.current.findIndex((h) => hunkCovers(h, line));
        if (idx < 0) return;
        e.event.preventDefault();
        const be = e.event.browserEvent;
        setGutPop({ x: be.clientX, y: be.clientY, idx });
      });

      // ↑/↓ in the popup: reveal the adjacent change and re-anchor the popup
      // under its stripe (reveal scrolls async, so position after it settles).
      const openPopAt = (idx: number) => {
        const h = hunksRef.current[idx];
        if (!h) return;
        const line = hunkLine(h);
        editor.revealLineInCenterIfOutsideViewport(line);
        window.setTimeout(() => {
          const vis = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
          const r = editor.getDomNode()?.getBoundingClientRect();
          setGutPop({
            x: (r?.left ?? 0) + 48,
            y: (r?.top ?? 0) + (vis?.top ?? 0) + (vis?.height ?? 19),
            idx,
          });
        }, 140);
      };
      gutCtlRef.current = {
        goto: openPopAt,
        // Restores the block to the baseline via an editor edit (so it lands in
        // the native undo stack), then persists through the normal save path.
        rollback: (h) => {
          const base = diffBaseRef.current;
          if (base == null || gmodel.isDisposed()) return;
          const repl =
            h.new_len > 0
              ? base
                  .split("\n")
                  .slice(h.new_start, h.new_start + h.new_len)
                  .join("\n") + "\n"
              : "";
          const range = new monaco.Range(h.old_start + 1, 1, h.old_start + h.old_len + 1, 1);
          editor.executeEdits("ff-rollback", [{ range, text: repl, forceMoveMarkers: true }]);
          setGutPop(null);
          editor.focus();
          onSave?.(editor.getValue(), false);
        },
        // Checkout the whole file from the baseline — every change reverts at
        // once, still as a single undoable edit.
        checkout: () => {
          const base = diffBaseRef.current;
          if (base == null || gmodel.isDisposed()) return;
          editor.executeEdits("ff-checkout", [{ range: gmodel.getFullModelRange(), text: base, forceMoveMarkers: true }]);
          setGutPop(null);
          editor.focus();
          onSave?.(editor.getValue(), false);
        },
      };
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
      <div ref={mdBodyRef} className={isMarkdown ? `md-body mode-${mdMode}` : "md-body"}>
        {isMarkdown && (
          <div className="md-toolbar" role="group" aria-label="Markdown view mode">
            {(["raw", "both", "read"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mdMode === m ? "on" : ""}
                title={m === "raw" ? "Source" : m === "both" ? "Editor and preview" : "Preview"}
                onClick={() => setMdMode(m)}
              >
                <MdIcon kind={m} />
              </button>
            ))}
          </div>
        )}
        <div
          className="editor-wrap"
          style={isMarkdown && mdMode === "both" ? { flex: `0 0 ${mdSplit * 100}%` } : undefined}
        >
          <Editor
            // Remount on keymap-style change so onMount re-binds editor commands
            // to the new scheme's physical keys (Monaco addCommand can't be
            // re-keyed). Models persist per path (keepCurrentModel), so undo
            // history survives.
            key={`km-${prefs.keymapStyle}`}
            theme={monacoThemeId(prefs.theme)}
        language={language}
        // Uncontrolled + one model per file path: keeps an isolated undo stack
        // per file and never records content swaps as undoable edits (which
        // made ⌘Z blank the file / pull in another file's text). External
        // content changes are synced by the effect above.
        path={path}
        defaultValue={content}
        keepCurrentModel={!!path}
        beforeMount={(m) => {
          defineAllThemes(m);
          initPluginsForMonaco(m);
        }}
        onMount={onMount}
        options={{
          readOnly: !!readOnly,
          // Go files own the glyph margin: implementation markers (LSP) and
          // test-run icons live there. Kept in this options object — it is
          // re-applied on every render, so a one-off updateOptions would be
          // silently reverted.
          glyphMargin: language === "go",
          // Off by default in Monaco; without it gopls semantic tokens are
          // requested but never painted.
          "semanticHighlighting.enabled": true,
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
        </div>
        {isMarkdown && mdMode === "both" && (
          <Splitter
            dir="x"
            onDelta={(d) => {
              const w = mdBodyRef.current?.clientWidth ?? 1;
              setMdSplit(getMdSplit() + d / w);
            }}
          />
        )}
        {isMarkdown && mdMode !== "raw" && (
          <div className="md-preview-pane">
            <MarkdownPreview source={mdSource} />
          </div>
        )}
      </div>
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
                title={it.run?.label ?? it.dbg?.name}
                onClick={() => {
                  setTestPick(null);
                  if (it.run) startRun(it.run).catch(() => {});
                  else if (it.dbg) startDebug(it.dbg).catch(() => {});
                }}
              >
                {it.dbg ? "🐞" : "▶"} {it.label}
              </button>
            ))}
          </div>
        </>
      )}
      {ifaceGen && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setIfaceGen(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setIfaceGen(null);
            }}
          />
          <div
            className="iface-pop"
            style={{
              left: Math.max(8, Math.min(ifaceGen.x, window.innerWidth - 560)),
              top: Math.max(8, Math.min(ifaceGen.y, window.innerHeight - 340)),
            }}
          >
            {ifaceGen.step === "search" ? (
              <>
                <div className="iface-pop-head">
                  <span>Choose interface to implement:</span>
                  <label className="iface-pop-toggle" title="Include interfaces outside this project (dependencies, stdlib)">
                    <input
                      type="checkbox"
                      checked={ifaceGen.nonProject}
                      onChange={(e) => setIfaceGen({ ...ifaceGen, nonProject: e.target.checked })}
                    />
                    Non-project
                  </label>
                </div>
                <input
                  className="iface-pop-search"
                  autoFocus
                  placeholder="Search interfaces…"
                  value={ifaceGen.query}
                  onChange={(e) => setIfaceGen({ ...ifaceGen, query: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setIfaceGen(null);
                    else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setIfaceGen({ ...ifaceGen, sel: Math.min(ifaceGen.sel + 1, ifaceGen.results.length - 1) });
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setIfaceGen({ ...ifaceGen, sel: Math.max(ifaceGen.sel - 1, 0) });
                    } else if (e.key === "Enter") {
                      const hit = ifaceGen.results[ifaceGen.sel];
                      if (hit)
                        setIfaceGen({
                          ...ifaceGen,
                          step: "name",
                          iface: hit,
                          typeName: ifaceGen.typeName || `${hit.name}Impl`,
                        });
                    }
                  }}
                />
                <div className="iface-pop-list">
                  {ifaceGen.results.map((s, i) => (
                    <button
                      key={`${s.path}:${s.line}:${s.name}`}
                      className={i === ifaceGen.sel ? "on" : ""}
                      onMouseEnter={() => setIfaceGen({ ...ifaceGen, sel: i })}
                      onClick={() =>
                        setIfaceGen({
                          ...ifaceGen,
                          step: "name",
                          iface: s,
                          typeName: ifaceGen.typeName || `${s.name}Impl`,
                        })
                      }
                    >
                      <span className="iface-name">{s.name}</span>
                      <span className="iface-pkg">in {s.pkgPath || s.path}</span>
                    </button>
                  ))}
                  {ifaceGen.results.length === 0 && (
                    <div className="iface-pop-none">{ifaceGen.query ? "No interfaces match." : "Type to search…"}</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="iface-pop-head">
                  <span>
                    Implement <b>{ifaceGen.iface?.name}</b> — type name:
                  </span>
                </div>
                <input
                  className="iface-pop-search"
                  autoFocus
                  value={ifaceGen.typeName}
                  disabled={ifaceGen.busy}
                  onChange={(e) => setIfaceGen({ ...ifaceGen, typeName: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setIfaceGen(null);
                    else if (e.key === "Enter" && ifaceGen.iface && /^[A-Za-z_]\w*$/.test(ifaceGen.typeName)) {
                      setIfaceGen({ ...ifaceGen, busy: true });
                      ifaceInsertRef.current(ifaceGen.iface, ifaceGen.typeName);
                    }
                  }}
                />
                <div className="iface-pop-none">
                  {ifaceGen.busy ? "Generating…" : "Enter creates the type with method stubs; Esc cancels."}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {gutPop && popHunk && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setGutPop(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setGutPop(null);
            }}
          />
          <div
            className="gut-pop"
            style={{
              left: Math.max(8, Math.min(gutPop.x, window.innerWidth - 580)),
              top: Math.max(8, Math.min(gutPop.y, window.innerHeight - 280)),
            }}
          >
            <div className="gut-pop-bar">
              <button
                title="Previous change"
                disabled={gutPop.idx === 0}
                onClick={() => gutCtlRef.current.goto(gutPop.idx - 1)}
              >
                ↑
              </button>
              <button
                title="Next change"
                disabled={gutPop.idx >= gutHunks.length - 1}
                onClick={() => gutCtlRef.current.goto(gutPop.idx + 1)}
              >
                ↓
              </button>
              <button title="Rollback this change" onClick={() => gutCtlRef.current.rollback(popHunk)}>
                ⟲
              </button>
              <button
                title="Checkout the base version of the whole file (reverts every change; ⌘Z undoes)"
                onClick={() => gutCtlRef.current.checkout()}
              >
                ⤓
              </button>
              {popHunk.new_len > 0 && (
                <button
                  title="Copy the previous text"
                  onClick={() => navigator.clipboard.writeText(popOldText).catch(() => {})}
                >
                  ⧉
                </button>
              )}
              <span className="gut-pop-count">
                {popHunk.new_len === 0 ? "Added" : popHunk.old_len === 0 ? "Deleted" : "Changed"} ·{" "}
                {gutPop.idx + 1}/{gutHunks.length}
              </span>
              <button title="Close" onClick={() => setGutPop(null)}>
                ✕
              </button>
            </div>
            {popHunk.new_len > 0 ? (
              oldHtml ? (
                <pre className="gut-pop-code" dangerouslySetInnerHTML={{ __html: oldHtml }} />
              ) : (
                <pre className="gut-pop-code">{popOldText}</pre>
              )
            ) : (
              <div className="gut-pop-empty">New lines — no base content</div>
            )}
          </div>
        </>
      )}
      <div className="statusbar">
        <span className="sb-lang">{langLabel(language)}</span>
        <span className="sb-diag" title={`${diag.errors} errors, ${diag.warnings} warnings`}>
          <span className={`sb-err${diag.errors > 0 ? " on" : ""}`}>⊘ {diag.errors}</span>
          <span className={`sb-warn${diag.warnings > 0 ? " on" : ""}`}>△ {diag.warnings}</span>
        </span>
        {lsp !== "off" && (
          <button
            type="button"
            className={`sb-lsp ${lsp}`}
            title="Click to restart gopls"
            disabled={lsp === "starting" || !root}
            onClick={() => root && restartLsp(root)}
          >
            ● {lspLabel[lsp]}
          </button>
        )}
        <span className="sb-spacer" />
        {zoomLevel !== 0 && (
          <button
            type="button"
            className="sb-zoom"
            title={`Editor zoom ${zoomPercent(zoomLevel)}% — click to reset to 100% (${formatCombo(comboFor("editor.zoomReset"))})`}
            onClick={() => resetZoom()}
          >
            🔍 {zoomPercent(zoomLevel)}% ⟲
          </button>
        )}
        <span className="sb-pos">
          Ln {pos.line}, Col {pos.col}
        </span>
      </div>
    </div>
  );
});

export default FileView;

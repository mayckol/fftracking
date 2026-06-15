// Minimal LSP client bridging gopls (one server per workspace root, spawned by
// the Rust side) to Monaco. Wires diagnostics, hover, completion, definition,
// signature help and document formatting for Go files over the `lsp://*` event
// channel. Not a full client — just the subset the editor surfaces use.

import type * as Monaco from "monaco-editor";
import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { cachedGoImportsConfig, importPlanner, loadGoImportsConfig, pkgNameOf } from "./goimports";
import { getPrefs } from "./uiPrefs";

type Json = any;

interface Conn {
  root: string;
  seq: number;
  ready: Promise<void>;
  pending: Map<number, (result: Json, error?: Json) => void>;
  /** TextDocumentSyncKind from the server: 2 = incremental, else full. */
  syncKind: number;
}

interface Doc {
  model: Monaco.editor.ITextModel;
  root: string;
  uri: string;
}

const conns = new Map<string, Conn>();
const docs = new Map<string, Doc>(); // keyed by absolute path
let M: typeof Monaco | null = null;
let registered = false;
let listening = false;

// Absolute paths that currently have ≥1 error diagnostic, for tree highlighting.
const errorPaths = new Set<string>();
const diagSubs = new Set<() => void>();

export function getErrorPaths(): Set<string> {
  return errorPaths;
}
export function subscribeDiagnostics(cb: () => void): () => void {
  diagSubs.add(cb);
  return () => diagSubs.delete(cb);
}

// Cross-file go-to-definition (⌘-click) routes here so the host can open the
// target file in its own editor; receives an absolute path + 1-based position.
let navHandler: ((path: string, line: number, col: number) => void) | null = null;
export function setNavHandler(fn: (path: string, line: number, col: number) => void): () => void {
  navHandler = fn;
  return () => {
    if (navHandler === fn) navHandler = null;
  };
}

// Coarse gopls lifecycle phase, broadcast on (re)start so status surfaces can
// reflect a restart triggered from anywhere (footbar click, command palette).
type LspPhase = "starting" | "ready" | "error";
const lspStateSubs = new Set<(root: string, phase: LspPhase) => void>();
export function subscribeLspState(cb: (root: string, phase: LspPhase) => void): () => void {
  lspStateSubs.add(cb);
  return () => lspStateSubs.delete(cb);
}
function emitLspState(root: string, phase: LspPhase) {
  for (const cb of lspStateSubs) cb(root, phase);
}

// Resolves once the dying process for `root` reports `lsp://exit`, so a restart
// can drain it before respawning — otherwise that late exit (which deletes the
// connection by root) would wipe the freshly created one.
function waitForExit(root: string, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let un: (() => void) | null = null;
    const finish = () => {
      un?.();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    listen<string>("lsp://exit", (e) => {
      if (e.payload !== root) return;
      clearTimeout(timer);
      finish();
    }).then((u) => {
      un = u;
    });
  });
}

/** Kill gopls for `root` and bring it back up, re-opening every doc already
 *  open under that root. Surfaces show "starting" → "ready"/"error" via
 *  subscribeLspState. The existing didChange subscriptions keep working: they
 *  route by root string, which the respawned server reuses. */
export async function restartLsp(root: string): Promise<void> {
  emitLspState(root, "starting");
  const reopen = [...docs.values()].filter((d) => d.root === root);
  conns.delete(root);
  await api.lspStop(root).catch(() => {});
  await waitForExit(root);
  try {
    const c = await ensureConn(root);
    for (const d of reopen) {
      notify(c, "textDocument/didOpen", {
        textDocument: { uri: d.uri, languageId: "go", version: 1, text: d.model.getValue() },
      });
    }
    emitLspState(root, "ready");
  } catch {
    emitLspState(root, "error");
  }
}

function fileUri(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}
function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function rawSend(root: string, obj: Json) {
  api.lspSend(root, JSON.stringify(obj)).catch(() => {});
}
function request(c: Conn, method: string, params: Json): Promise<Json> {
  const id = ++c.seq;
  return new Promise((resolve, reject) => {
    c.pending.set(id, (result, error) => (error ? reject(error) : resolve(result)));
    rawSend(c.root, { jsonrpc: "2.0", id, method, params });
  });
}
function notify(c: Conn, method: string, params: Json) {
  rawSend(c.root, { jsonrpc: "2.0", method, params });
}

// Settings handed to gopls via workspace/configuration. completeUnimported
// makes unimported package members show up in completion (with the import
// attached as an additionalTextEdit); usePlaceholders gives JetBrains-style
// argument placeholders on call completion.
const GOPLS_SETTINGS: Json = {
  completeUnimported: true,
  usePlaceholders: true,
  // Off by default in gopls; needed for rich highlighting (functions, types,
  // namespaces) beyond Monaco's lexical Go tokenizer.
  semanticTokens: true,
};

/** Applies an LSP WorkspaceEdit to whatever target models are open. All edits
 *  for one document go through a single pushEditOperations call (LSP TextEdits
 *  are all relative to the same document state) so undo stays one step. */
function applyWorkspaceEdit(we: Json): boolean {
  if (!we) return false;
  let applied = false;
  const apply = (uri: string, edits: Json[]) => {
    const doc = docs.get(uriToPath(uri));
    if (!doc || !edits?.length) return;
    doc.model.pushEditOperations(
      [],
      edits.map((e) => ({ range: range(e.range), text: e.newText })),
      () => null,
    );
    applied = true;
  };
  if (Array.isArray(we.documentChanges)) {
    for (const dc of we.documentChanges) {
      if (dc.textDocument && dc.edits) apply(dc.textDocument.uri, dc.edits);
    }
  } else if (we.changes) {
    for (const [uri, edits] of Object.entries(we.changes)) apply(uri, edits as Json[]);
  }
  return applied;
}

// gopls sends a few requests back that must be answered or it stalls.
function serverReply(method: string, params: Json): Json {
  if (method === "workspace/configuration") return (params?.items ?? []).map(() => GOPLS_SETTINGS);
  if (method === "workspace/applyEdit") return { applied: applyWorkspaceEdit(params?.edit) };
  return null;
}

async function ensureListener() {
  if (listening) return;
  listening = true;
  await listen<{ root: string; body: string }>("lsp://message", (e) => {
    const c = conns.get(e.payload.root);
    if (!c) return;
    let msg: Json;
    try {
      msg = JSON.parse(e.payload.body);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      rawSend(c.root, { jsonrpc: "2.0", id: msg.id, result: serverReply(msg.method, msg.params) });
      return;
    }
    if (msg.id !== undefined) {
      const p = c.pending.get(msg.id);
      if (p) {
        c.pending.delete(msg.id);
        p(msg.result, msg.error);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") applyDiagnostics(msg.params);
  });
  await listen<string>("lsp://exit", (e) => conns.delete(e.payload));
}

function sev(s: number): Monaco.MarkerSeverity {
  const m = M!.MarkerSeverity;
  return s === 1 ? m.Error : s === 2 ? m.Warning : s === 3 ? m.Info : m.Hint;
}

function applyDiagnostics(params: Json) {
  if (!M) return;
  const path = uriToPath(params.uri);
  const diags = params.diagnostics ?? [];

  // Track error files for the tree, even if the doc isn't open in an editor.
  const hadError = errorPaths.has(path);
  const hasError = diags.some((d: Json) => (d.severity ?? 1) === 1);
  if (hasError) errorPaths.add(path);
  else errorPaths.delete(path);
  if (hasError !== hadError) diagSubs.forEach((cb) => cb());

  const doc = docs.get(path);
  if (!doc) return;
  const markers = diags.map((d: Json) => ({
    severity: sev(d.severity ?? 1),
    message: d.message,
    source: d.source,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  }));
  M.editor.setModelMarkers(doc.model, "gopls", markers);
}

async function ensureConn(root: string): Promise<Conn> {
  const existing = conns.get(root);
  if (existing) {
    await existing.ready;
    return existing;
  }
  let resolveReady!: () => void;
  let rejectReady!: (e: Json) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const c: Conn = { root, seq: 0, ready, pending: new Map(), syncKind: 1 };
  conns.set(root, c);
  try {
    await ensureListener();
    await api.lspStart(root);
    const init = await request(c, "initialize", {
      processId: null,
      rootUri: fileUri(root),
      workspaceFolders: [{ uri: fileUri(root), name: root.split("/").pop() || root }],
      // Also pass settings here, not just via workspace/configuration: gopls
      // decides whether to advertise the semanticTokensProvider at initialize
      // time from these options. Without semanticTokens here it defaults to off,
      // never advertises the provider, and registerSemanticTokens (gated on the
      // legend) never runs — so no token is ever colored by gopls.
      initializationOptions: GOPLS_SETTINGS,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              commitCharactersSupport: true,
              preselectSupport: true,
              insertReplaceSupport: true,
              deprecatedSupport: true,
              labelDetailsSupport: true,
              // Lets gopls defer the expensive parts (docs, import edits for
              // unimported symbols) to completionItem/resolve — the list
              // itself comes back faster.
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source", "source.organizeImports"],
              },
            },
            resolveSupport: { properties: ["edit"] },
          },
          signatureHelp: {},
          definition: {},
          implementation: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          publishDiagnostics: {},
          semanticTokens: {
            requests: { full: true },
            // Token names gopls may answer with; the actual mapping comes from
            // the legend in the server's initialize result.
            tokenTypes: [
              "namespace", "type", "class", "enum", "interface", "struct",
              "typeParameter", "parameter", "variable", "property", "enumMember",
              "event", "function", "method", "macro", "keyword", "modifier",
              "comment", "string", "number", "regexp", "operator", "decorator",
              "label",
            ],
            tokenModifiers: [
              "declaration", "definition", "readonly", "static", "deprecated",
              "abstract", "async", "modification", "documentation", "defaultLibrary",
            ],
            formats: ["relative"],
          },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          symbol: {},
        },
      },
    });
    const sync = init?.capabilities?.textDocumentSync;
    c.syncKind = typeof sync === "number" ? sync : (sync?.change ?? 1);
    const legend = init?.capabilities?.semanticTokensProvider?.legend;
    if (legend) registerSemanticTokens(legend);
    notify(c, "initialized", {});
    resolveReady();
  } catch (e) {
    rejectReady(e);
    conns.delete(root);
    throw e;
  }
  return c;
}

// Registered lazily: Monaco needs the token legend, and that only arrives in
// gopls's initialize result. One registration covers every workspace.
let semanticRegistered = false;
let fireSemanticChange: (() => void) | null = null;

// Ask Monaco to re-request semantic tokens for every open Go model. Used right
// after a doc opens on a freshly-ready connection.
function refreshSemanticTokens() {
  fireSemanticChange?.();
}

// gopls tags BOTH a called package func (fx.Provide) and one passed by name
// (fxproviders.ProvideConfig) as the same "function" token, so semantic tokens
// can't tell a call from a reference — that split is purely syntactic and is
// handled by the Monarch "function.call" rule. Drop function/method *uses* here
// so they don't repaint the Monarch colors (an unmapped semantic token does NOT
// fall through to the Monarch color in standalone Monaco — it overpaints with
// the editor's default foreground). Keep *declarations* (definition/declaration
// modifier): a func/method name sits before "(" too, so Monarch would color it
// like a call; keeping the token lets it fall to the neutral editor foreground.
// Re-bases the relative (deltaLine, deltaStart) encoding via absolute positions.
function dropFunctionUses(
  data: number[],
  fnIdx: number,
  mIdx: number,
  declMask: number,
): Uint32Array {
  const out: number[] = [];
  let line = 0;
  let char = 0;
  let prevLine = 0;
  let prevChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dLine = data[i];
    if (dLine === 0) char += data[i + 1];
    else {
      line += dLine;
      char = data[i + 1];
    }
    const type = data[i + 3];
    const mods = data[i + 4];
    if ((type === fnIdx || type === mIdx) && (mods & declMask) === 0) continue;
    const outLine = line - prevLine;
    out.push(outLine, outLine === 0 ? char - prevChar : char, data[i + 2], type, mods);
    prevLine = line;
    prevChar = char;
  }
  return new Uint32Array(out);
}

function registerSemanticTokens(legend: { tokenTypes: string[]; tokenModifiers: string[] }) {
  if (semanticRegistered || !M) return;
  semanticRegistered = true;

  const fnIdx = legend.tokenTypes.indexOf("function");
  const mIdx = legend.tokenTypes.indexOf("method");
  const defBit = legend.tokenModifiers.indexOf("definition");
  const declBit = legend.tokenModifiers.indexOf("declaration");
  const declMask = (defBit >= 0 ? 1 << defBit : 0) | (declBit >= 0 ? 1 << declBit : 0);
  const filterFns = fnIdx >= 0 || mIdx >= 0;

  const listeners = new Set<() => void>();
  fireSemanticChange = () => listeners.forEach((l) => l());

  M.languages.registerDocumentSemanticTokensProvider("go", {
    onDidChange: ((cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    }) as Json,
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model) {
      const d = docForModel(model);
      if (!d) return null;
      const r = await request(d.conn, "textDocument/semanticTokens/full", {
        textDocument: { uri: d.uri },
      });
      if (!r?.data) return null;
      const data = filterFns
        ? dropFunctionUses(r.data, fnIdx, mIdx, declMask)
        : new Uint32Array(r.data);
      return { data, resultId: r.resultId };
    },
    releaseDocumentSemanticTokens() {},
  });
}

function pos(p: Monaco.IPosition) {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}
function range(r: Json): Monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function docForModel(model: Monaco.editor.ITextModel): { conn: Conn; uri: string } | null {
  for (const d of docs.values()) {
    if (d.model === model) {
      const conn = conns.get(d.root);
      if (conn) return { conn, uri: d.uri };
    }
  }
  return null;
}

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind by name.
function ckind(k: number | undefined): Monaco.languages.CompletionItemKind {
  const K = M!.languages.CompletionItemKind;
  const names = [
    "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class",
    "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword",
    "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant",
    "Struct", "Event", "Operator", "TypeParameter",
  ];
  const name = k ? names[k - 1] : "Text";
  return (K as Json)[name] ?? K.Text;
}

// LSP SymbolKind → Monaco CompletionItemKind for synthesized symbol items.
function symCkind(k: number | undefined): Monaco.languages.CompletionItemKind {
  const K = M!.languages.CompletionItemKind;
  switch (k) {
    case 5: return K.Class;
    case 6: return K.Method;
    case 8: return K.Field;
    case 10: return K.Enum;
    case 11: return K.Interface;
    case 12: return K.Function;
    case 13: return K.Variable;
    case 14: return K.Constant;
    case 23: return K.Struct;
    default: return K.Reference;
  }
}

const SYMBOL_ITEM_CAP = 50;

/** Turns workspace/symbol hits into `pkg.Symbol` completion items carrying the
 *  import as an additionalTextEdit — bare-identifier auto-import, the case
 *  gopls's own completion doesn't cover. */
function symbolSuggestions(args: {
  model: Monaco.editor.ITextModel;
  uri: string;
  root: string;
  symbols: Json[];
  items: Json[];
  fallbackRange: Monaco.IRange;
}): Json[] {
  const { model, uri, root, symbols, items, fallbackRange } = args;
  if (!symbols.length) return [];
  const plan = importPlanner(model, cachedGoImportsConfig(root), getPrefs().goImportStyle);
  const curDir = uriToPath(uri).replace(/\/[^/]*$/, "");
  const offered = new Set(
    items.map((it) => (typeof it.label === "string" ? it.label : it.label?.label)),
  );
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (out.length >= SYMBOL_ITEM_CAP) break;
    const locUri = s?.location?.uri;
    const pkgPath = s?.containerName;
    if (!locUri || !pkgPath || !/^[A-Z]/.test(s.name ?? "")) continue;
    // Same package: no qualifier needed, gopls completes these already.
    if (uriToPath(locUri).replace(/\/[^/]*$/, "") === curDir) continue;
    const p = plan(pkgPath, pkgNameOf(pkgPath));
    if (!p) continue;
    const label = p.qualifier ? `${p.qualifier}.${s.name}` : s.name;
    if (seen.has(label) || offered.has(label)) continue;
    seen.add(label);
    out.push({
      label: { label, description: pkgPath },
      kind: symCkind(s.kind),
      insertText: label,
      // Filter against the bare name — that's what the user typed.
      filterText: s.name,
      // Sink below gopls's context-aware suggestions.
      sortText: "￿" + s.name,
      detail: pkgPath,
      additionalTextEdits: p.edit ? [p.edit] : undefined,
      range: fallbackRange,
    });
  }
  return out;
}

function registerProviders(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;

  // Go's built-in Monarch grammar tags every identifier the same ("identifier"),
  // so a function call and a bare reference are indistinguishable — and gopls
  // can't separate them either (both are the "function" semantic token). Re-
  // register the grammar with one change: an identifier immediately before "("
  // becomes "function.call" (themed blue); everything else stays "identifier"
  // (themed neutral). Faithful copy of monaco-editor 0.52 basic-languages/go
  // with only that first root rule split in two.
  monaco.languages.setMonarchTokensProvider("go", {
    defaultToken: "",
    tokenPostfix: ".go",
    keywords: [
      "break", "case", "chan", "const", "continue", "default", "defer", "else",
      "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
      "map", "package", "range", "return", "select", "struct", "switch", "type",
      "var", "bool", "true", "false", "uint8", "uint16", "uint32", "uint64",
      "int8", "int16", "int32", "int64", "float32", "float64", "complex64",
      "complex128", "byte", "rune", "uint", "int", "uintptr", "string", "nil",
    ],
    operators: [
      "+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", "&^", "+=", "-=", "*=",
      "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "&^=", "&&", "||", "<-", "++",
      "--", "==", "<", ">", "=", "!", "!=", "<=", ">=", ":=", "...", "(", ")",
      "[", "]", "{", "}", ",", ";", ".", ":",
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
      root: [
        [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "function.call" } }],
        [/[a-zA-Z_]\w*/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "identifier" } }],
        { include: "@whitespace" },
        [/\[\[.*\]\]/, "annotation"],
        [/^\s*#\w+/, "keyword"],
        [/[{}()\[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "delimiter", "@default": "" } }],
        [/\d*\d+[eE]([\-+]?\d+)?/, "number.float"],
        [/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
        [/0[xX][0-9a-fA-F']*[0-9a-fA-F]/, "number.hex"],
        [/0[0-7']*[0-7]/, "number.octal"],
        [/0[bB][0-1']*[0-1]/, "number.binary"],
        [/\d[\d']*/, "number"],
        [/\d/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/`/, "string", "@rawstring"],
        [/'[^\\']'/, "string"],
        [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
        [/'/, "string.invalid"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@doccomment"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      doccomment: [
        [/[^/*]+/, "comment.doc"],
        [/\/\*/, "comment.doc.invalid"],
        [/\*\//, "comment.doc", "@pop"],
        [/[/*]/, "comment.doc"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],
      rawstring: [
        [/[^`]/, "string"],
        [/`/, "string", "@pop"],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  // Cross-file ⌘-click: Monaco asks to open another resource — hand it to the
  // host (which loads that file into the editor) instead of failing silently.
  monaco.editor.registerEditorOpener?.({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (!navHandler) return false;
      const sel = selectionOrPosition as Json;
      const line = sel?.startLineNumber ?? sel?.lineNumber ?? 1;
      const col = sel?.startColumn ?? sel?.column ?? 1;
      navHandler(uriToPath(resource.toString()), line, col);
      return true;
    },
  });

  monaco.languages.registerHoverProvider("go", {
    async provideHover(model, position) {
      const d = docForModel(model);
      if (!d) return null;
      const r = await request(d.conn, "textDocument/hover", {
        textDocument: { uri: d.uri },
        position: pos(position),
      });
      if (!r || !r.contents) return null;
      const c = r.contents;
      const value =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((x: Json) => (typeof x === "string" ? x : x.value)).join("\n\n")
            : c.value;
      return { contents: [{ value }], range: r.range ? range(r.range) : undefined };
    },
  });

  const lspEdit = (e: Json) => ({ range: range(e.range), text: e.newText });
  const lspDoc = (doc: Json) =>
    typeof doc === "string" ? doc : doc ? { value: doc.value } : undefined;

  monaco.languages.registerCompletionItemProvider("go", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position, context) {
      const d = docForModel(model);
      if (!d) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      // Bare-identifier cross-package completion (JetBrains style): gopls only
      // completes unimported symbols when qualified, so in parallel with the
      // normal request we hit its workspace symbol index and synthesize
      // `pkg.Symbol` items with the import edit attached. Skipped on `.`
      // trigger (member access — qualified path already handles it).
      const wantSymbols = context.triggerCharacter !== "." && word.word.length >= 2;
      const [r, syms] = await Promise.all([
        request(d.conn, "textDocument/completion", {
          textDocument: { uri: d.uri },
          position: pos(position),
        }),
        wantSymbols
          ? request(d.conn, "workspace/symbol", { query: word.word }).catch(() => [])
          : Promise.resolve([]),
      ]);
      const items: Json[] = Array.isArray(r) ? r : r?.items ?? [];
      const fallbackRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const symbolItems = symbolSuggestions({
        model,
        uri: d.uri,
        root: d.conn.root,
        symbols: syms ?? [],
        items,
        fallbackRange,
      });
      return {
        incomplete: r?.isIncomplete || symbolItems.length > 0,
        suggestions: symbolItems.concat(items.map((it) => {
          const label = typeof it.label === "string" ? it.label : it.label.label;
          const te = it.textEdit;
          const rng =
            te?.insert && te?.replace
              ? { insert: range(te.insert), replace: range(te.replace) }
              : te?.range
                ? range(te.range)
                : fallbackRange;
          return {
            label: it.labelDetails ? { label, detail: it.labelDetails.detail, description: it.labelDetails.description } : label,
            kind: ckind(it.kind),
            insertText: it.insertText ?? te?.newText ?? label,
            insertTextRules:
              it.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            detail: it.detail,
            documentation: lspDoc(it.documentation),
            sortText: it.sortText,
            filterText: it.filterText,
            preselect: it.preselect,
            commitCharacters: it.commitCharacters,
            tags: it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
            // This is what makes auto-import work: gopls attaches the import
            // statement here and Monaco applies it when the item is accepted.
            additionalTextEdits: it.additionalTextEdits?.map(lspEdit),
            range: rng,
            // Raw LSP item so resolveCompletionItem can round-trip it.
            __lsp: { item: it, conn: d.conn },
          } as Json;
        })),
      };
    },
    // gopls defers docs + import edits for unimported symbols to resolve;
    // Monaco calls this only for the focused item, and applies
    // additionalTextEdits that arrive here even after accept.
    async resolveCompletionItem(item: Json) {
      const raw = item.__lsp;
      if (!raw || item.__resolved) return item;
      item.__resolved = true;
      try {
        const r = await request(raw.conn, "completionItem/resolve", raw.item);
        if (r) {
          if (r.detail) item.detail = r.detail;
          if (r.documentation) item.documentation = lspDoc(r.documentation);
          if (r.additionalTextEdits?.length) item.additionalTextEdits = r.additionalTextEdits.map(lspEdit);
        }
      } catch {
        // Resolve is best-effort; the unresolved item is still usable.
      }
      return item;
    },
  });

  monaco.languages.registerCodeActionProvider("go", {
    async provideCodeActions(model, rng, context) {
      const d = docForModel(model);
      if (!d) return null;
      let actions: Json[];
      try {
        actions =
          (await request(d.conn, "textDocument/codeAction", {
            textDocument: { uri: d.uri },
            range: {
              start: { line: rng.startLineNumber - 1, character: rng.startColumn - 1 },
              end: { line: rng.endLineNumber - 1, character: rng.endColumn - 1 },
            },
            context: {
              diagnostics: context.markers.map((m) => ({
                range: {
                  start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
                  end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
                },
                message: m.message,
                severity: m.severity === M!.MarkerSeverity.Error ? 1 : 2,
                source: m.source,
              })),
              only: context.only ? [context.only] : undefined,
            },
          })) ?? [];
      } catch {
        return null;
      }
      return {
        actions: actions
          .filter((a) => a && a.title)
          .map((a) => ({
            title: a.title,
            kind: a.kind,
            isPreferred: a.isPreferred,
            diagnostics: [],
            edit: undefined,
            __lsp: { action: a, conn: d.conn },
          })) as Json[],
        dispose() {},
      };
    },
    async resolveCodeAction(action: Json) {
      const raw = action.__lsp;
      if (!raw) return action;
      let a = raw.action;
      // Lazily resolve the edit, then run it ourselves: Monaco's workspace
      // edit service can't write files the host owns, and command-style
      // actions go back to gopls which answers with workspace/applyEdit.
      if (!a.edit && a.data) {
        try {
          a = (await request(raw.conn, "codeAction/resolve", a)) ?? a;
        } catch {
          /* fall through to command */
        }
      }
      if (a.edit) applyWorkspaceEdit(a.edit);
      else if (a.command) {
        request(raw.conn, "workspace/executeCommand", {
          command: a.command.command,
          arguments: a.command.arguments,
        }).catch(() => {});
      }
      return action;
    },
  });

  monaco.languages.registerDefinitionProvider("go", {
    async provideDefinition(model, position) {
      const d = docForModel(model);
      if (!d) return null;
      const r = await request(d.conn, "textDocument/definition", {
        textDocument: { uri: d.uri },
        position: pos(position),
      });
      const locs: Json[] = Array.isArray(r) ? r : r ? [r] : [];
      return locs.map((l) => ({
        uri: monaco.Uri.parse(l.uri ?? l.targetUri),
        range: range(l.range ?? l.targetSelectionRange ?? l.targetRange),
      }));
    },
  });

  monaco.languages.registerImplementationProvider("go", {
    async provideImplementation(model, position) {
      const d = docForModel(model);
      if (!d) return null;
      const r = await request(d.conn, "textDocument/implementation", {
        textDocument: { uri: d.uri },
        position: pos(position),
      });
      const locs: Json[] = Array.isArray(r) ? r : r ? [r] : [];
      return locs.map((l) => ({
        uri: monaco.Uri.parse(l.uri ?? l.targetUri),
        range: range(l.range ?? l.targetSelectionRange ?? l.targetRange),
      }));
    },
  });

  monaco.languages.registerSignatureHelpProvider("go", {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position) {
      const d = docForModel(model);
      if (!d) return null;
      const r = await request(d.conn, "textDocument/signatureHelp", {
        textDocument: { uri: d.uri },
        position: pos(position),
      });
      if (!r || !r.signatures?.length) return null;
      return {
        value: {
          signatures: r.signatures.map((s: Json) => ({
            label: s.label,
            documentation: s.documentation,
            parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label })),
          })),
          activeSignature: r.activeSignature ?? 0,
          activeParameter: r.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider("go", {
    async provideDocumentFormattingEdits(model) {
      const d = docForModel(model);
      if (!d) return [];
      const edits: Json[] = await request(d.conn, "textDocument/formatting", {
        textDocument: { uri: d.uri },
        options: { tabSize: 4, insertSpaces: false },
      });
      return (edits ?? []).map((e) => ({ range: range(e.range), text: e.newText }));
    },
  });
}

export interface ImplLocation {
  /** Absolute file path. */
  path: string;
  line: number;
  col: number;
}

/** Implementation / specification targets for the symbol at (line, col),
 *  resolved straight from gopls (1-based Monaco coordinates in and out). */
export async function implementationLocations(
  model: Monaco.editor.ITextModel,
  line: number,
  col: number,
): Promise<ImplLocation[]> {
  const d = docForModel(model);
  if (!d) return [];
  const r = await request(d.conn, "textDocument/implementation", {
    textDocument: { uri: d.uri },
    position: { line: line - 1, character: col - 1 },
  });
  const locs: Json[] = Array.isArray(r) ? r : r ? [r] : [];
  return locs.map((l) => {
    const rg = l.range ?? l.targetSelectionRange ?? l.targetRange;
    return {
      path: uriToPath(l.uri ?? l.targetUri),
      line: rg.start.line + 1,
      col: rg.start.character + 1,
    };
  });
}

export interface IfaceSymbol {
  name: string;
  /** Import path (gopls puts it in containerName). */
  pkgPath: string;
  /** Absolute file path of the declaration. */
  path: string;
  /** 1-based declaration line. */
  line: number;
}

/** Interfaces matching `query` from gopls's workspace symbol index (covers the
 *  workspace and its dependencies). Backs the implement-interface picker. */
export async function workspaceInterfaces(
  model: Monaco.editor.ITextModel,
  query: string,
): Promise<IfaceSymbol[]> {
  const d = docForModel(model);
  if (!d) return [];
  const syms: Json[] = (await request(d.conn, "workspace/symbol", { query })) ?? [];
  return syms
    .filter((s) => s?.kind === SK_INTERFACE && s.location?.uri)
    .map((s) => ({
      name: s.name as string,
      pkgPath: (s.containerName as string) ?? "",
      path: uriToPath(s.location.uri),
      line: (s.location.range?.start?.line ?? 0) + 1,
    }));
}

/** Asks gopls for the source.organizeImports action on `model` and applies it
 *  (add missing / drop unused imports). No-op for non-LSP models. */
export async function organizeImports(model: Monaco.editor.ITextModel): Promise<void> {
  const d = docForModel(model);
  if (!d) return;
  try {
    const actions: Json[] =
      (await request(d.conn, "textDocument/codeAction", {
        textDocument: { uri: d.uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: model.getLineCount() - 1, character: 0 },
        },
        context: { diagnostics: [], only: ["source.organizeImports"] },
      })) ?? [];
    for (let a of actions) {
      if (!a.edit && a.data) a = (await request(d.conn, "codeAction/resolve", a)) ?? a;
      if (a.edit) applyWorkspaceEdit(a.edit);
      else if (a.command) {
        await request(d.conn, "workspace/executeCommand", {
          command: a.command.command,
          arguments: a.command.arguments,
        });
      }
    }
  } catch {
    // Best-effort: formatting still proceeds without import cleanup.
  }
}

/** Routes a cross-file jump through the host's open-file handler (the same
 *  path ⌘-click definition uses). False when no handler is mounted. */
export function openLocation(path: string, line: number, col: number): boolean {
  if (!navHandler) return false;
  navHandler(path, line, col);
  return true;
}

/** A gutter marker for the implementations relationship (JetBrains-style).
 *  "impls": interface / interface method that concrete types implement (↓);
 *  "spec": concrete type / method that satisfies an interface (↑). */
export interface ImplAnnotation {
  line: number;
  col: number;
  kind: "impls" | "spec";
  count: number;
}

// LSP SymbolKind values we annotate.
const SK_CLASS = 5;
const SK_METHOD = 6;
const SK_INTERFACE = 11;
const SK_STRUCT = 23;
// Don't hammer gopls on generated files with hundreds of symbols.
const MAX_IMPL_PROBES = 150;

/** Scans `model`'s document symbols and probes gopls for implementation links,
 *  returning one annotation per symbol that has any. */
export async function implementationAnnotations(
  model: Monaco.editor.ITextModel,
): Promise<ImplAnnotation[]> {
  const d = docForModel(model);
  if (!d) return [];
  const symbols: Json[] =
    (await request(d.conn, "textDocument/documentSymbol", {
      textDocument: { uri: d.uri },
    })) ?? [];

  const targets: { sym: Json; kind: "impls" | "spec" }[] = [];
  const walk = (list: Json[], inInterface: boolean) => {
    for (const s of list) {
      if (targets.length >= MAX_IMPL_PROBES) return;
      if (s.kind === SK_INTERFACE) {
        targets.push({ sym: s, kind: "impls" });
        walk(s.children ?? [], true);
      } else if (s.kind === SK_METHOD) {
        targets.push({ sym: s, kind: inInterface ? "impls" : "spec" });
      } else if (s.kind === SK_STRUCT || s.kind === SK_CLASS) {
        targets.push({ sym: s, kind: "spec" });
        walk(s.children ?? [], false);
      } else {
        walk(s.children ?? [], inInterface);
      }
    }
  };
  walk(symbols, false);

  const out = await Promise.all(
    targets.map(async ({ sym, kind }) => {
      const sel = sym.selectionRange ?? sym.range;
      if (!sel) return null;
      try {
        const r = await request(d.conn, "textDocument/implementation", {
          textDocument: { uri: d.uri },
          position: { line: sel.start.line, character: sel.start.character },
        });
        const locs: Json[] = Array.isArray(r) ? r : r ? [r] : [];
        if (locs.length === 0) return null;
        return {
          line: sel.start.line + 1,
          col: sel.start.character + 1,
          kind,
          count: locs.length,
        } satisfies ImplAnnotation;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((a): a is ImplAnnotation => a !== null);
}

interface AttachArgs {
  monaco: typeof Monaco;
  model: Monaco.editor.ITextModel;
  root: string;
  path: string;
}

/// Open `model` (a Go file at `path` under workspace `root`) with gopls.
/// Idempotent per path; cleans up on model disposal.
export async function attachGo({ monaco, model, root, path }: AttachArgs) {
  M = monaco;
  registerProviders(monaco);
  // Models are kept per path across editor remounts — same model showing up
  // again is already open and listened to; re-attaching would double didOpen
  // and the didChange subscription.
  if (docs.get(path)?.model === model) return;
  // Warm the .golangci.yml/go.mod config cache so completion (sync hot path)
  // can read it.
  loadGoImportsConfig(root).catch(() => {});
  const uri = fileUri(path);
  // Register the doc BEFORE ensureConn. The semantic-tokens provider is created
  // inside ensureConn (once gopls returns its legend) and Monaco asks it for
  // tokens immediately. If this model isn't in `docs` yet, docForModel() returns
  // null, the provider returns null, and Monaco caches that empty result with no
  // content change to ever retrigger it — the whole file renders uncolored.
  docs.set(path, { model, root, uri });
  const c = await ensureConn(root);

  notify(c, "textDocument/didOpen", {
    textDocument: { uri, languageId: "go", version: 1, text: model.getValue() },
  });
  // The connection is ready now; nudge Monaco to re-fetch in case its first
  // semantic-tokens request raced ahead of it and came back empty.
  refreshSemanticTokens();

  let version = 1;
  const sub = model.onDidChangeContent((e) => {
    version++;
    // Incremental sync when the server supports it (gopls does): send only
    // the changed ranges instead of re-serializing the whole file per
    // keystroke. Monaco orders the changes so sequential application is
    // correct, which matches LSP semantics.
    const contentChanges =
      c.syncKind === 2
        ? e.changes.map((ch) => ({
            range: {
              start: { line: ch.range.startLineNumber - 1, character: ch.range.startColumn - 1 },
              end: { line: ch.range.endLineNumber - 1, character: ch.range.endColumn - 1 },
            },
            text: ch.text,
          }))
        : [{ text: model.getValue() }];
    notify(c, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges,
    });
  });
  model.onWillDispose(() => {
    sub.dispose();
    notify(c, "textDocument/didClose", { textDocument: { uri } });
    docs.delete(path);
  });
}

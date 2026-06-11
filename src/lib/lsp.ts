// Minimal LSP client bridging gopls (one server per workspace root, spawned by
// the Rust side) to Monaco. Wires diagnostics, hover, completion, definition,
// signature help and document formatting for Go files over the `lsp://*` event
// channel. Not a full client — just the subset the editor surfaces use.

import type * as Monaco from "monaco-editor";
import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";

type Json = any;

interface Conn {
  root: string;
  seq: number;
  ready: Promise<void>;
  pending: Map<number, (result: Json, error?: Json) => void>;
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

// gopls sends a few requests back that must be answered or it stalls.
function serverReply(method: string, params: Json): Json {
  if (method === "workspace/configuration") return (params?.items ?? []).map(() => ({}));
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
  const c: Conn = { root, seq: 0, ready, pending: new Map() };
  conns.set(root, c);
  try {
    await ensureListener();
    await api.lspStart(root);
    await request(c, "initialize", {
      processId: null,
      rootUri: fileUri(root),
      workspaceFolders: [{ uri: fileUri(root), name: root.split("/").pop() || root }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: {
            contextSupport: true,
            completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
          },
          signatureHelp: {},
          definition: {},
          formatting: {},
          publishDiagnostics: {},
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    });
    notify(c, "initialized", {});
    resolveReady();
  } catch (e) {
    rejectReady(e);
    conns.delete(root);
    throw e;
  }
  return c;
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

function registerProviders(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;

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

  monaco.languages.registerCompletionItemProvider("go", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const d = docForModel(model);
      if (!d) return { suggestions: [] };
      const r = await request(d.conn, "textDocument/completion", {
        textDocument: { uri: d.uri },
        position: pos(position),
      });
      const items: Json[] = Array.isArray(r) ? r : r?.items ?? [];
      const word = model.getWordUntilPosition(position);
      const rng = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: items.map((it) => {
          const label = typeof it.label === "string" ? it.label : it.label.label;
          return {
            label,
            kind: ckind(it.kind),
            insertText: it.insertText ?? it.textEdit?.newText ?? label,
            insertTextRules:
              it.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            detail: it.detail,
            documentation:
              typeof it.documentation === "string"
                ? it.documentation
                : it.documentation
                  ? { value: it.documentation.value }
                  : undefined,
            sortText: it.sortText,
            filterText: it.filterText,
            range: rng,
          };
        }),
      };
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
  const c = await ensureConn(root);
  const uri = fileUri(path);
  docs.set(path, { model, root, uri });

  notify(c, "textDocument/didOpen", {
    textDocument: { uri, languageId: "go", version: 1, text: model.getValue() },
  });

  let version = 1;
  const sub = model.onDidChangeContent(() => {
    version++;
    notify(c, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
  });
  model.onWillDispose(() => {
    sub.dispose();
    notify(c, "textDocument/didClose", { textDocument: { uri } });
    docs.delete(path);
  });
}

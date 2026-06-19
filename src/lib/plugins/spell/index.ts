import type { Monaco } from "@monaco-editor/react";
import type { editor as MEditor, IDisposable, languages } from "monaco-editor";
import type { FFPlugin } from "../types";
import { addUserWord, addUserWords, check, isUserWord, suggest } from "./client";

const ID = "spell";
const OWNER = "spell";
const ADD_CMD = "ff.spell.addWord";
const ADD_ALL_CMD = "ff.spell.addAllInFile";
const DEBOUNCE_MS = 500;
// Past this the per-keystroke full rescan stops being cheap; large generated
// files aren't prose worth flagging anyway.
const MAX_CHARS = 600_000;

// Every attached editor's rescan, so accepting a word can refresh all open
// models at once.
const scanners = new Set<() => void>();
let globalsReady = false;

function markFor(monaco: Monaco, model: MEditor.ITextModel, start: number, end: number, word: string): MEditor.IMarkerData {
  const s = model.getPositionAt(start);
  const e = model.getPositionAt(end);
  return {
    startLineNumber: s.lineNumber,
    startColumn: s.column,
    endLineNumber: e.lineNumber,
    endColumn: e.column,
    message: `"${word}" may be misspelled`,
    severity: monaco.MarkerSeverity.Info,
    source: OWNER,
  };
}

// Distinct words behind the model's current spell markers, in document order.
function fileWords(monaco: Monaco, model: MEditor.ITextModel): string[] {
  const marks = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.source === OWNER);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const m of marks) {
    const w = model.getValueInRange(new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn));
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
  }
  return words;
}

function registerGlobals(monaco: Monaco) {
  if (globalsReady) return;
  globalsReady = true;

  monaco.editor.registerCommand(ADD_CMD, (_accessor, word: string) => {
    addUserWord(word);
    scanners.forEach((fn) => fn());
  });

  // Every distinct flagged word in one file → the user dictionary. Reads the
  // model's current spell markers so it tracks whatever is squiggled now.
  monaco.editor.registerCommand(ADD_ALL_CMD, (_accessor, uri: string) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    addUserWords(fileWords(monaco, model));
    scanners.forEach((fn) => fn());
  });

  monaco.languages.registerCodeActionProvider("*", {
    provideCodeActions: async (model, _range, context) => {
      const marks = context.markers.filter((m) => m.source === OWNER);
      if (!marks.length) return { actions: [], dispose() {} };

      const actions: languages.CodeAction[] = [];
      for (const m of marks) {
        const range = new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn);
        const word = model.getValueInRange(range);
        const suggestions = await suggest(word);
        for (const s of suggestions) {
          actions.push({
            title: `Replace with "${s}"`,
            kind: "quickfix",
            diagnostics: [m],
            edit: { edits: [{ resource: model.uri, textEdit: { range, text: s }, versionId: model.getVersionId() }] },
          });
        }
        actions.push({
          title: `Add "${word}" to dictionary`,
          kind: "quickfix",
          diagnostics: [m],
          command: { id: ADD_CMD, title: "Add to dictionary", arguments: [word] },
        });
      }

      // Offer a bulk accept when the file has more than the one under the cursor.
      const all = fileWords(monaco, model);
      if (all.length > 1) {
        actions.push({
          title: `Add all ${all.length} flagged words in file to dictionary`,
          kind: "quickfix",
          command: { id: ADD_ALL_CMD, title: "Add all to dictionary", arguments: [model.uri.toString()] },
        });
      }
      return { actions, dispose() {} };
    },
  });
}

function attach(monaco: Monaco, editor: MEditor.ICodeEditor): () => void {
  const model = editor.getModel();
  if (!model) return () => {};
  registerGlobals(monaco);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scan = async () => {
    if (disposed) return;
    const text = model.getValue();
    if (text.length > MAX_CHARS) {
      monaco.editor.setModelMarkers(model, OWNER, []);
      return;
    }
    const startVersion = model.getVersionId();
    const bad = await check(text);
    // Content moved on while the worker ran — its offsets are stale, drop them;
    // the change that bumped the version already queued a fresh scan.
    if (disposed || model.getVersionId() !== startVersion) return;
    const filtered = bad.filter((b) => !isUserWord(b.word));
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      filtered.map((b) => markFor(monaco, model, b.start, b.end, b.word)),
    );
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  };

  scanners.add(scan);
  const sub: IDisposable = model.onDidChangeContent(schedule);
  void scan();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    sub.dispose();
    scanners.delete(scan);
    monaco.editor.setModelMarkers(model, OWNER, []);
  };
}

export const spellPlugin: FFPlugin = {
  manifest: {
    id: ID,
    name: "Spell Check",
    description: "Inline spell checking for EN-us and PT-br with suggestions and a per-word dictionary.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  editor: { attach },
};

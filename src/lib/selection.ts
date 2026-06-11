// Registry of live Monaco editors so the search palette can seed its query
// from whatever text the user has selected, regardless of which view it's in.

import type { editor } from "monaco-editor";

const editors = new Set<editor.ICodeEditor>();

/** Tracks an editor until it is disposed. */
export function registerEditor(ed: editor.ICodeEditor) {
  editors.add(ed);
  ed.onDidDispose(() => editors.delete(ed));
}

/** The selected text — from the focused Monaco editor first, then any editor
 *  with a selection, then the DOM selection. Empty string when nothing. */
export function getSelectedText(): string {
  let fallback = "";
  for (const ed of editors) {
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || sel.isEmpty() || !model) continue;
    const text = model.getValueInRange(sel);
    if (!text) continue;
    if (ed.hasTextFocus()) return text;
    if (!fallback) fallback = text;
  }
  return fallback || (window.getSelection()?.toString() ?? "");
}

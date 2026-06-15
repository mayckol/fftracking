// Global handlers for editor folding + zoom. Wired through the app-wide
// shortcut registry (which matches on KeyboardEvent.key) rather than Monaco's
// own keybindings (which match physical KeyCodes) — so the number-row and
// numpad +/-/− keys all work, and the combos fire regardless of which editor
// view is mounted.

import type { editor as MEditor } from "monaco-editor";
import { focusedEditor } from "./selection";
import { resetZoom, zoomIn, zoomOut } from "./editorZoom";

let lastFold = 0;
let lastUnfold = 0;

// Minimal shape of Monaco's (untyped, internal) folding contribution + model.
interface FoldRegion {
  isCollapsed: boolean;
}
interface FoldModel {
  getAllRegionsAtLine(line: number, filter?: (r: FoldRegion, level: number) => boolean): FoldRegion[];
  toggleCollapseState(regions: FoldRegion[]): void;
}
interface FoldController {
  getFoldingModel?: () => Promise<FoldModel | null> | null;
}

// Collapse/expand the nearest enclosing block at the cursor. getAllRegionsAtLine
// returns the regions containing the line innermost-first; we filter to the ones
// in the wrong state and toggle the innermost — so a press always acts on the
// tightest block around the cursor even when it sits on a body line, and
// repeated presses walk outward. Returns false if folding data isn't ready.
async function toggleEnclosing(ed: MEditor.ICodeEditor, collapse: boolean): Promise<boolean> {
  const ctrl = ed.getContribution("editor.contrib.folding") as FoldController | null;
  const model = await ctrl?.getFoldingModel?.();
  const line = ed.getPosition()?.lineNumber;
  if (!model || !line) return false;
  const regions = model.getAllRegionsAtLine(line, (r) => r.isCollapsed !== collapse);
  if (regions.length === 0) return false;
  model.toggleCollapseState([regions[0]]);
  return true;
}

export async function foldAtCursor() {
  const ed = focusedEditor();
  if (!ed) return;
  const now = performance.now();
  const wasRecent = now - lastFold < 450;
  lastFold = now;
  // Quick second press collapses the whole file.
  if (wasRecent) {
    ed.getAction("editor.foldAll")?.run();
    return;
  }
  if (!(await toggleEnclosing(ed, true))) ed.getAction("editor.fold")?.run();
}

export async function unfoldAtCursor() {
  const ed = focusedEditor();
  if (!ed) return;
  const now = performance.now();
  const wasRecent = now - lastUnfold < 450;
  lastUnfold = now;
  if (wasRecent) {
    ed.getAction("editor.unfoldAll")?.run();
    return;
  }
  if (!(await toggleEnclosing(ed, false))) ed.getAction("editor.unfold")?.run();
}

export { resetZoom, zoomIn, zoomOut };

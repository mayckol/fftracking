// Global handlers for editor folding + zoom. Wired through the app-wide
// shortcut registry (which matches on KeyboardEvent.key) rather than Monaco's
// own keybindings (which match physical KeyCodes) — so the number-row and
// numpad +/-/− keys all work, and the combos fire regardless of which editor
// view is mounted.

import { focusedEditor } from "./selection";
import { resetZoom, zoomIn, zoomOut } from "./editorZoom";

let lastFold = 0;
let lastUnfold = 0;

function runOnFocused(action: string) {
  focusedEditor()?.getAction(action)?.run();
}

// One press folds/unfolds the block at the cursor; a quick second press widens
// to the whole file.
export function foldAtCursor() {
  const now = performance.now();
  runOnFocused(now - lastFold < 450 ? "editor.foldAll" : "editor.fold");
  lastFold = now;
}

export function unfoldAtCursor() {
  const now = performance.now();
  runOnFocused(now - lastUnfold < 450 ? "editor.unfoldAll" : "editor.unfold");
  lastUnfold = now;
}

export { resetZoom, zoomIn, zoomOut };

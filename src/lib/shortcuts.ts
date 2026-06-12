// In-app keyboard shortcuts: a small action registry + one global key handler.
// Bindings are user-editable (Settings → Shortcuts) and persisted to
// localStorage. "Mod" is ⌘ on macOS and Ctrl elsewhere.

import { useEffect } from "react";

export type ActionGroup = "Editor" | "Diff" | "Capture & revert" | "Changed files" | "Navigation" | "Search" | "Debug";

/** Pseudo-combo for two bare Shift presses in quick succession (JetBrains
 *  "Search Everywhere"). Handled by a dedicated detector, not combo matching. */
export const DOUBLE_SHIFT = "DoubleShift";

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  default: string;
  /** When "diff", the binding only fires while the diff editor has focus, so it
   *  doesn't steal keys (e.g. ⌘Z) from other text fields. */
  scope?: "diff";
}

export const ACTIONS: ActionDef[] = [
  // Editor actions are bound inside Monaco (the editor reads these combos); they
  // have no global handler, so the key passes through to the focused editor.
  { id: "editor.format", label: "Format document", group: "Editor", default: "Mod+Shift+L" },
  { id: "editor.gotoDef", label: "Go to definition", group: "Editor", default: "F12" },
  { id: "editor.save", label: "Save file", group: "Editor", default: "Mod+S" },
  { id: "editor.duplicateLine", label: "Duplicate line", group: "Editor", default: "Mod+D" },
  { id: "editor.deleteWord", label: "Delete word (end → start)", group: "Editor", default: "Mod+W" },
  { id: "editor.deleteLine", label: "Delete line", group: "Editor", default: "Alt+D" },
  { id: "editor.findNext", label: "Find next match", group: "Editor", default: "Mod+G" },
  { id: "editor.replace", label: "Replace in file", group: "Editor", default: "Mod+R" },
  { id: "editor.expandSelection", label: "Expand selection", group: "Editor", default: "Mod+Shift+]" },
  { id: "editor.shrinkSelection", label: "Shrink selection", group: "Editor", default: "Mod+Shift+[" },
  { id: "editor.jumpBracket", label: "Go to matching bracket", group: "Editor", default: "Mod+[" },
  { id: "editor.gotoFileStart", label: "Go to first line", group: "Editor", default: "Mod+ArrowUp" },
  { id: "editor.gotoFileEnd", label: "Go to last line", group: "Editor", default: "Mod+ArrowDown" },
  { id: "editor.commentLine", label: "Toggle comment (line / selection)", group: "Editor", default: "Mod+/" },
  { id: "editor.implementations", label: "Go to implementations / specifications", group: "Editor", default: "Mod+U" },
  { id: "editor.implementIface", label: "Implement interface (generate stubs)", group: "Editor", default: "Ctrl+I" },
  { id: "test.run", label: "Run test at cursor", group: "Editor", default: "Ctrl+Shift+R" },
  { id: "editor.fold", label: "Collapse block (press twice: all)", group: "Editor", default: "Mod+Shift+-" },
  { id: "editor.unfold", label: "Expand block (press twice: all)", group: "Editor", default: "Mod+Shift+=" },
  { id: "diff.next", label: "Next change", group: "Diff", default: "Alt+ArrowDown" },
  { id: "diff.prev", label: "Previous change", group: "Diff", default: "Alt+ArrowUp" },
  { id: "diff.revertBlock", label: "Revert current block", group: "Diff", default: "Alt+R" },
  { id: "diff.undo", label: "Undo", group: "Diff", default: "Mod+Z", scope: "diff" },
  { id: "diff.redo", label: "Redo", group: "Diff", default: "Mod+Shift+Z", scope: "diff" },
  { id: "diff.layout", label: "Toggle split / inline", group: "Diff", default: "Alt+L" },
  { id: "capture.snapshot", label: "Snapshot now", group: "Capture & revert", default: "Mod+Shift+S" },
  { id: "revert.file", label: "Revert file to point", group: "Capture & revert", default: "Mod+Alt+R" },
  { id: "file.copyPath", label: "Copy file path", group: "Changed files", default: "Mod+Shift+C" },
  { id: "file.copyContent", label: "Copy file contents", group: "Changed files", default: "Mod+Alt+C" },
  { id: "file.reveal", label: "Reveal in file manager", group: "Changed files", default: "Mod+Shift+E" },
  { id: "file.open", label: "Open file", group: "Changed files", default: "Mod+Shift+O" },
  { id: "file.focusInTree", label: "Focus opened file in tree", group: "Changed files", default: "Mod+O" },
  { id: "nav.history", label: "Go to History tab", group: "Navigation", default: "Mod+1" },
  { id: "nav.git", label: "Go to Git tab", group: "Navigation", default: "Mod+2" },
  { id: "nav.settings", label: "Go to Settings tab", group: "Navigation", default: "Mod+3" },
  { id: "nav.back", label: "Navigate back", group: "Navigation", default: "Mod+Alt+ArrowLeft" },
  { id: "nav.forward", label: "Navigate forward", group: "Navigation", default: "Mod+Alt+ArrowRight" },
  { id: "nav.nextPoint", label: "Next breaking point", group: "Navigation", default: "Alt+PageDown" },
  { id: "nav.prevPoint", label: "Previous breaking point", group: "Navigation", default: "Alt+PageUp" },
  { id: "terminal.toggle", label: "Toggle terminal", group: "Navigation", default: "Mod+`" },
  { id: "settings.palette", label: "Open settings palette", group: "Navigation", default: "Mod+," },
  // Debug bindings follow JetBrains defaults (F8/F7/⇧F8/F9).
  { id: "debug.toggleBreakpoint", label: "Toggle breakpoint at cursor", group: "Debug", default: "Mod+F8" },
  { id: "debug.stepOver", label: "Step over", group: "Debug", default: "F8" },
  { id: "debug.stepInto", label: "Step into", group: "Debug", default: "F7" },
  { id: "debug.stepOut", label: "Step out", group: "Debug", default: "Shift+F8" },
  { id: "debug.resume", label: "Resume program", group: "Debug", default: "F9" },
  { id: "debug.stop", label: "Stop debug session", group: "Debug", default: "Mod+F2" },
  { id: "debug.panel", label: "Toggle debug panel", group: "Debug", default: "Mod+Shift+D" },
  { id: "search.quickOpen", label: "Find files & folders", group: "Search", default: DOUBLE_SHIFT },
  { id: "search.text", label: "Find in files", group: "Search", default: "Mod+Shift+F" },
  { id: "search.replace", label: "Replace in files", group: "Search", default: "Mod+Shift+R" },
];

export const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
const STORE_KEY = "ff.shortcuts";

type KeyMap = Record<string, string>;

let overrides: KeyMap = load();
const registry = new Map<string, () => void>();
const subscribers = new Set<() => void>();
let capturing: ((combo: string) => void) | null = null;

function load(): KeyMap {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  subscribers.forEach((fn) => fn());
}

export function comboFor(id: string): string {
  if (id in overrides) return overrides[id];
  return ACTIONS.find((a) => a.id === id)?.default ?? "";
}

export function setCombo(id: string, combo: string) {
  if (!combo || combo === (ACTIONS.find((a) => a.id === id)?.default ?? "")) delete overrides[id];
  else overrides[id] = combo;
  persist();
}

export function resetCombo(id: string) {
  delete overrides[id];
  persist();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Shift produces a different character on US layouts ("{", "_", "+", …);
// store the unshifted key so combos stay canonical ("Mod+Shift+[").
const SHIFTED: Record<string, string> = {
  "{": "[", "}": "]", "_": "-", "+": "=", "?": "/", ":": ";", '"': "'",
  "<": ",", ">": ".", "|": "\\", "~": "`",
  ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
  "&": "7", "*": "8", "(": "9",
};

/** Serializes a keydown into a comparable combo string, or "" for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
  if (key === " ") key = "Space";
  if (key in SHIFTED) key = SHIFTED[key];
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

const SYMBOL: Record<string, string> = {
  Mod: IS_MAC ? "⌘" : "Ctrl",
  Alt: IS_MAC ? "⌥" : "Alt",
  Shift: IS_MAC ? "⇧" : "Shift",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

export function formatCombo(combo: string): string {
  if (!combo) return "—";
  if (combo === DOUBLE_SHIFT) return IS_MAC ? "⇧ ⇧" : "Shift Shift";
  const parts = combo.split("+").map((p) => SYMBOL[p] ?? p);
  return parts.join(IS_MAC ? " " : "+");
}

function inTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** Listens for the next real combo and reports it once (used by the rebind UI). */
export function beginCapture(onCombo: (combo: string) => void): () => void {
  capturing = onCombo;
  return () => {
    capturing = null;
  };
}

const DOUBLE_SHIFT_MS = 400;
let lastShiftAt = 0;

function fireDoubleShift(e: KeyboardEvent) {
  const action = ACTIONS.find((a) => comboFor(a.id) === DOUBLE_SHIFT);
  if (!action) return;
  // Never steal Shift from a focused terminal.
  if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
  const handler = registry.get(action.id);
  if (!handler) return;
  e.preventDefault();
  e.stopPropagation();
  handler();
}

function onKeyDown(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  // Double-Shift: two bare Shift presses with nothing in between. A held key
  // (repeat) or any other key/modifier resets the sequence, so Shift-typing
  // capitals never triggers it.
  if (e.key === "Shift" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !capturing) {
    const now = performance.now();
    if (now - lastShiftAt < DOUBLE_SHIFT_MS) {
      lastShiftAt = 0;
      fireDoubleShift(e);
    } else {
      lastShiftAt = now;
    }
    return;
  }
  lastShiftAt = 0;
  if (!combo) return;
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    const cb = capturing;
    capturing = null;
    cb(combo);
    return;
  }
  // Don't hijack plain typing in inputs/editors; only modified combos and
  // function keys (debug stepping) fire there.
  if (inTextField() && !/(^|\+)(Mod|Alt)(\+|$)/.test(combo) && !/^(Shift\+)?F\d+$/.test(combo)) return;
  const action = ACTIONS.find((a) => comboFor(a.id) === combo);
  if (!action) return;
  const el = document.activeElement as HTMLElement | null;
  // While a terminal is focused, only the toggle fires; every other combo goes
  // to the shell (Ctrl-C, Ctrl-R, etc.).
  if (action.id !== "terminal.toggle" && el?.closest(".xterm")) return;
  // Diff-scoped bindings (undo/redo) only act when the diff editor is focused,
  // so they don't steal ⌘Z from the commit box or other inputs.
  if (action.scope === "diff" && !el?.closest(".editor-wrap")) return;
  const handler = registry.get(action.id);
  if (!handler) return;
  // Capture-phase stop so the focused control (e.g. Monaco) doesn't also act.
  e.preventDefault();
  e.stopPropagation();
  handler();
}

let installed = false;
export function installShortcuts() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
}

/** Registers a handler for an action while the calling component is mounted. */
export function useShortcut(id: string, handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    registry.set(id, handler);
    return () => {
      if (registry.get(id) === handler) registry.delete(id);
    };
  }, [id, handler, enabled]);
}

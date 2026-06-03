// In-app keyboard shortcuts: a small action registry + one global key handler.
// Bindings are user-editable (Settings → Shortcuts) and persisted to
// localStorage. "Mod" is ⌘ on macOS and Ctrl elsewhere.

import { useEffect } from "react";

export type ActionGroup = "Diff" | "Capture & revert" | "Changed files" | "Navigation";

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  default: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "diff.next", label: "Next change", group: "Diff", default: "Alt+ArrowDown" },
  { id: "diff.prev", label: "Previous change", group: "Diff", default: "Alt+ArrowUp" },
  { id: "diff.revertBlock", label: "Revert current block to point", group: "Diff", default: "Alt+R" },
  { id: "diff.layout", label: "Toggle split / inline", group: "Diff", default: "Alt+L" },
  { id: "capture.snapshot", label: "Snapshot now", group: "Capture & revert", default: "Mod+Shift+S" },
  { id: "revert.file", label: "Revert file to point", group: "Capture & revert", default: "Mod+Alt+R" },
  { id: "file.copyPath", label: "Copy file path", group: "Changed files", default: "Mod+Shift+C" },
  { id: "file.copyContent", label: "Copy file contents", group: "Changed files", default: "Mod+Alt+C" },
  { id: "file.reveal", label: "Reveal in file manager", group: "Changed files", default: "Mod+Shift+E" },
  { id: "file.open", label: "Open file", group: "Changed files", default: "Mod+Shift+O" },
  { id: "nav.history", label: "Go to History tab", group: "Navigation", default: "Mod+1" },
  { id: "nav.git", label: "Go to Git tab", group: "Navigation", default: "Mod+2" },
  { id: "nav.settings", label: "Go to Settings tab", group: "Navigation", default: "Mod+3" },
  { id: "nav.nextPoint", label: "Next breaking point", group: "Navigation", default: "Alt+PageDown" },
  { id: "nav.prevPoint", label: "Previous breaking point", group: "Navigation", default: "Alt+PageUp" },
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

/** Serializes a keydown into a comparable combo string, or "" for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
  if (key === " ") key = "Space";
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

function onKeyDown(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    const cb = capturing;
    capturing = null;
    cb(combo);
    return;
  }
  // Don't hijack plain typing in inputs/editors; only modified combos fire there.
  if (inTextField() && !/(^|\+)(Mod|Alt)(\+|$)/.test(combo)) return;
  const action = ACTIONS.find((a) => comboFor(a.id) === combo);
  if (!action) return;
  const handler = registry.get(action.id);
  if (!handler) return;
  e.preventDefault();
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

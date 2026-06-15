// Local UI preferences (window-only, no backend): persisted to localStorage and
// broadcast to subscribers so open views update live.

import { useEffect, useReducer } from "react";
import { getTheme } from "./themes";

export type TabOverflow = "fifo" | "block";

/** How Go auto-import places new imports (and how on-save regrouping sorts
 *  the block): follow .golangci.yml sections, mirror the file's existing
 *  groups, or keep one flat alphabetical block. */
export type GoImportStyle = "golangci" | "grouped" | "flat";

/** Keyboard scheme, decoupled from the host OS. `native` follows the OS (⌘ on
 *  macOS, Ctrl elsewhere); `mac` and `pc` force their scheme on any OS. */
export type KeymapStyle = "native" | "mac" | "pc";

export interface UIPrefs {
  autohideSidebar: boolean;
  maxTabs: number;
  tabOverflow: TabOverflow;
  autoSave: boolean;
  formatOnSave: boolean;
  goImportStyle: GoImportStyle;
  goImportsOnSave: boolean;
  fontFamily: string;
  fontSize: number;
  indentGuides: boolean;
  theme: string;
  iconPack: string;
  // Font + size for folder/file names in the project tree.
  treeFont: string;
  treeFontSize: number;
  keymapStyle: KeymapStyle;
  // The style active before the last change — drives "revert to previous".
  keymapStylePrev: KeymapStyle;
  // True once the user has made (or dismissed) the first-run keymap choice.
  keymapStyleChosen: boolean;
}

const DEFAULTS: UIPrefs = {
  autohideSidebar: false,
  maxTabs: 8,
  tabOverflow: "fifo",
  autoSave: true,
  formatOnSave: false,
  goImportStyle: "grouped",
  goImportsOnSave: false,
  fontFamily: "JetBrains Mono",
  fontSize: 12.5,
  indentGuides: true,
  theme: "tokyo-night",
  iconPack: "material",
  treeFont: "JetBrains Mono",
  treeFontSize: 11.5,
  keymapStyle: "native",
  keymapStylePrev: "native",
  keymapStyleChosen: false,
};

/** Pushes prefs that drive CSS (not Monaco) onto the document root. */
export function applyUIVars(p: UIPrefs) {
  document.documentElement.style.setProperty("--tree-font", `${p.treeFont}, ui-monospace, monospace`);
  document.documentElement.style.setProperty("--tree-font-size", `${p.treeFontSize}px`);
}

export const FONT_CHOICES = [
  "JetBrains Mono",
  "Fira Code",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Source Code Pro",
  "Cascadia Code",
  "IBM Plex Mono",
];

// Shared Monaco options derived from prefs: font + indentation guides + rulers.
export function editorPrefOptions(p: UIPrefs) {
  const themeVars = getTheme(p.theme).cssVars;
  return {
    fontFamily: `${p.fontFamily}, monospace`,
    fontSize: p.fontSize,
    guides: { indentation: p.indentGuides, highlightActiveIndentation: p.indentGuides },
    // Soft column guides at the conventional 80/120 line-length limits.
    rulers: [
      { column: 80, color: themeVars["--ruler-80"] },
      { column: 120, color: themeVars["--ruler-120"] },
    ],
  };
}

const KEY = "ff.uiPrefs";
const subs = new Set<() => void>();

function load(): UIPrefs {
  let parsed: Partial<UIPrefs> = {};
  let existed = false;
  try {
    const raw = localStorage.getItem(KEY);
    existed = raw != null;
    parsed = raw ? (JSON.parse(raw) as Partial<UIPrefs>) : {};
  } catch {
    parsed = {};
  }
  const merged = { ...DEFAULTS, ...parsed };
  // Upgraders (prefs predate this feature) keep `native` and are never prompted;
  // the first-run chooser is reserved for genuinely fresh installs.
  if (existed && parsed.keymapStyle === undefined && parsed.keymapStyleChosen === undefined) {
    merged.keymapStyleChosen = true;
  }
  return merged;
}

let cur = load();

// Persist the upgrade migration once so the flag survives restarts: a stored
// blob that predates the keymap fields gets them written back now.
{
  const raw = localStorage.getItem(KEY);
  if (raw && !raw.includes("keymapStyleChosen")) localStorage.setItem(KEY, JSON.stringify(cur));
}

function commit() {
  localStorage.setItem(KEY, JSON.stringify(cur));
  subs.forEach((fn) => fn());
}

export function getPrefs(): UIPrefs {
  return cur;
}

export function setPref<K extends keyof UIPrefs>(key: K, value: UIPrefs[K]) {
  cur = { ...cur, [key]: value };
  commit();
}

/** Switch keymap style, remembering the outgoing value so the change is
 *  undoable, and marking the first-run choice as made. */
export function setKeymapStyle(next: KeymapStyle) {
  if (next === cur.keymapStyle) {
    if (!cur.keymapStyleChosen) setPref("keymapStyleChosen", true);
    return;
  }
  cur = { ...cur, keymapStylePrev: cur.keymapStyle, keymapStyle: next, keymapStyleChosen: true };
  commit();
}

/** Back to the OS-native default; still recorded so it too can be reverted. */
export function revertToOriginal() {
  setKeymapStyle("native");
}

/** Undo the last style change by swapping current ↔ previous (toggles on repeat). */
export function revertToPrevious() {
  cur = { ...cur, keymapStyle: cur.keymapStylePrev, keymapStylePrev: cur.keymapStyle, keymapStyleChosen: true };
  commit();
}

/** Dismiss the first-run chooser without changing the style. */
export function markKeymapChosen() {
  if (!cur.keymapStyleChosen) setPref("keymapStyleChosen", true);
}

export function subscribePrefs(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function useUIPrefs(): UIPrefs {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    subs.add(force);
    return () => {
      subs.delete(force);
    };
  }, []);
  return cur;
}

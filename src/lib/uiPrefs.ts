// Local UI preferences (window-only, no backend): persisted to localStorage and
// broadcast to subscribers so open views update live.

import { useEffect, useReducer } from "react";
import { getTheme } from "./themes";

export type TabOverflow = "fifo" | "block";

/** How Go auto-import places new imports (and how on-save regrouping sorts
 *  the block): follow .golangci.yml sections, mirror the file's existing
 *  groups, or keep one flat alphabetical block. */
export type GoImportStyle = "golangci" | "grouped" | "flat";

export interface UIPrefs {
  autohideSidebar: boolean;
  maxTabs: number;
  tabOverflow: TabOverflow;
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
}

const DEFAULTS: UIPrefs = {
  autohideSidebar: false,
  maxTabs: 8,
  tabOverflow: "fifo",
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
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<UIPrefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

let cur = load();

export function getPrefs(): UIPrefs {
  return cur;
}

export function setPref<K extends keyof UIPrefs>(key: K, value: UIPrefs[K]) {
  cur = { ...cur, [key]: value };
  localStorage.setItem(KEY, JSON.stringify(cur));
  subs.forEach((fn) => fn());
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

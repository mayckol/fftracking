// Local UI preferences (window-only, no backend): persisted to localStorage and
// broadcast to subscribers so open views update live.

import { useEffect, useReducer } from "react";

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
};

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
  return {
    fontFamily: `${p.fontFamily}, monospace`,
    fontSize: p.fontSize,
    guides: { indentation: p.indentGuides, highlightActiveIndentation: p.indentGuides },
    // Soft column guides at the conventional 80/120 line-length limits.
    rulers: [
      { column: 80, color: "#1c2430" },
      { column: 120, color: "#283344" },
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

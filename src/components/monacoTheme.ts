import type { Monaco } from "@monaco-editor/react";
import { THEMES, getTheme, type Theme } from "../lib/themes";

export function defineThemeFor(monaco: Monaco, theme: Theme) {
  monaco.editor.defineTheme(theme.id, {
    base: theme.monaco.base,
    inherit: true,
    rules: theme.monaco.rules,
    colors: theme.monaco.colors,
  });
}

// Registered up front so switching later is a plain setTheme (the `theme`
// prop on the editors), which applies globally to every mounted editor.
export function defineAllThemes(monaco: Monaco) {
  for (const t of THEMES) defineThemeFor(monaco, t);
}

/** Monaco theme name for a (possibly unknown) app theme id. */
export function monacoThemeId(themeId: string): string {
  return getTheme(themeId).id;
}

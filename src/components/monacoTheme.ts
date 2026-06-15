import type { Monaco } from "@monaco-editor/react";
import { THEMES, getTheme, type Theme } from "../lib/themes";
import type { MonacoTokenRule } from "../lib/themes";

// Monaco's base themes (vs-dark/vs) ship language-specific token rules —
// string.key.json, string.value.json, keyword.json, *.css, *.html … — which
// are MORE specific than a theme's generic `string`/`keyword`/`number`, so with
// inherit:true they win and JSON/CSS/HTML render in the base palette instead of
// ours. Re-map those scopes onto each theme's own generic colors so every
// language follows the selected theme.
function languageScopeOverrides(theme: Theme): MonacoTokenRule[] {
  const rules = theme.monaco.rules;
  const fg = (token: string, fallback?: string) =>
    rules.find((r) => r.token === token)?.foreground ?? fallback;

  const string = fg("string");
  const keyword = fg("keyword");
  const number = fg("number");
  const type = fg("type", string);
  const delimiter = fg("delimiter");
  const tag = fg("tag", keyword);
  const attrName = fg("attribute.name", type);

  const out: MonacoTokenRule[] = [];
  const add = (token: string, foreground?: string) => {
    if (foreground) out.push({ token, foreground });
  };

  // JSON
  add("string.key.json", type);
  add("string.value.json", string);
  add("keyword.json", keyword);
  add("number.json", number);
  // CSS / SCSS / LESS numeric attribute values
  add("attribute.value.hex.css", number);
  add("attribute.value.number.css", number);
  add("attribute.value.unit.css", number);
  add("attribute.value.number", number);
  add("attribute.value.unit", number);
  // HTML / XML
  add("tag", tag);
  add("metatag", keyword);
  add("metatag.content.html", string);
  add("metatag.html", keyword);
  add("metatag.xml", keyword);
  add("delimiter.html", delimiter);
  add("delimiter.xml", delimiter);
  add("attribute.name", attrName);
  add("attribute.value", string);
  add("attribute.value.html", string);
  add("attribute.value.xml", string);
  add("string.html", string);
  add("string.key", type);
  add("string.value", string);
  return out;
}

export function defineThemeFor(monaco: Monaco, theme: Theme) {
  monaco.editor.defineTheme(theme.id, {
    base: theme.monaco.base,
    inherit: true,
    rules: [...theme.monaco.rules, ...languageScopeOverrides(theme)],
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

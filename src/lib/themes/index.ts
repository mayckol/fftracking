import { fftrackDark } from "./fftrackDark";
import { tokyoNight } from "./tokyoNight";
import type { Theme } from "./types";

export type { MonacoThemeSpec, MonacoTokenRule, Theme } from "./types";

export const THEMES: Theme[] = [tokyoNight, fftrackDark];

export const DEFAULT_THEME_ID = tokyoNight.id;

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? tokyoNight;
}

export function applyTheme(theme: Theme) {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(theme.cssVars)) {
    style.setProperty(name, value);
  }
}

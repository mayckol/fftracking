export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface MonacoThemeSpec {
  base: "vs" | "vs-dark";
  rules: MonacoTokenRule[];
  colors: Record<string, string>;
}

/** Declarative theme: values for every color CSS variable the app declares in
 *  :root, plus the Monaco editor theme generated from the same palette. */
export interface Theme {
  id: string;
  label: string;
  appearance: "dark" | "light";
  cssVars: Record<string, string>;
  monaco: MonacoThemeSpec;
}

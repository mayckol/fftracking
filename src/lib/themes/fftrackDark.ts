import type { Theme } from "./types";

// The original app palette, captured verbatim from styles.css :root and the
// previous hard-coded Monaco theme.
export const fftrackDark: Theme = {
  id: "fftrack-dark",
  label: "FFTrack Dark",
  appearance: "dark",
  cssVars: {
    "--bg-0": "#0a0c10",
    "--bg-1": "#0e1116",
    "--bg-2": "#141a21",
    "--bg-3": "#1b232d",
    "--bg-4": "#232d39",

    "--line": "#1e2630",
    "--line-2": "#2b3744",
    "--line-3": "#3a4756",

    "--tx-0": "#e6edf3",
    "--tx-1": "#9aa7b4",
    "--tx-2": "#5d6b7a",
    "--tx-3": "#3d4855",

    "--ac": "#7c8cff",
    "--ac-dim": "#5663cc",
    "--ac-bright": "#93a0ff",
    "--ac-glow": "rgba(124, 140, 255, 0.16)",

    "--add": "#3fb950",
    "--add-bg": "rgba(63, 185, 80, 0.13)",
    "--mod": "#e3b341",
    "--mod-bg": "rgba(227, 179, 65, 0.13)",
    "--del": "#f0626e",
    "--del-bg": "rgba(240, 98, 110, 0.13)",
    "--conflict": "#ff8c42",
    "--conflict-bg": "rgba(255, 140, 66, 0.14)",

    "--err-soft": "#d2786a",
    "--warn-soft": "#d6b16a",
    "--chg-soft": "#3e9e54",
    "--ok-soft": "#5fb37a",

    "--t-event": "#4cc4c0",
    "--t-event-bg": "rgba(76, 196, 192, 0.1)",
    "--t-interval": "#7c8cff",
    "--t-manual": "#8a94a3",
    "--t-revert": "#f0626e",

    "--debug-hint": "#5e7ca0",
    "--debug-name": "#c792ea",

    "--glow-1": "rgba(124, 140, 255, 0.05)",
    "--glow-2": "rgba(76, 196, 192, 0.035)",

    "--ruler-80": "#1c2430",
    "--ruler-120": "#283344",
  },
  monaco: {
    base: "vs-dark",
    rules: [
      { token: "comment", foreground: "5d6b7a", fontStyle: "italic" },
      { token: "keyword", foreground: "7c8cff" },
      { token: "string", foreground: "4cc4c0" },
      { token: "number", foreground: "e3b341" },
      // Function CALLS (Monarch: an identifier right before "(") → blue.
      // References and declaration names stay neutral white: gopls function/
      // method *uses* are filtered in lsp.ts, *declarations* fall to the editor
      // foreground. Type/namespace semantic rules below still apply.
      { token: "function.call", foreground: "93a0ff" },
      { token: "identifier", foreground: "e6edf3" },
      { token: "namespace", foreground: "e6edf3" },
      { token: "type", foreground: "4cc4c0" },
      { token: "struct", foreground: "4cc4c0" },
      { token: "interface", foreground: "4cc4c0" },
      { token: "class", foreground: "4cc4c0" },
      { token: "enum", foreground: "4cc4c0" },
      { token: "typeParameter", foreground: "4cc4c0" },
      { token: "parameter", foreground: "e6edf3" },
      { token: "variable", foreground: "e6edf3" },
      { token: "property", foreground: "e6edf3" },
      { token: "enumMember", foreground: "e3b341" },
      { token: "variable.readonly", foreground: "e3b341" },
    ],
    colors: {
      "editor.background": "#0a0c10",
      "editor.foreground": "#e6edf3",
      "editorGutter.background": "#0a0c10",
      "editorLineNumber.foreground": "#3d4855",
      "editorLineNumber.activeForeground": "#9aa7b4",
      "editor.lineHighlightBackground": "#161b22",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#33455a",
      "editor.selectionHighlightBackground": "#2b374466",
      "diffEditor.insertedTextBackground": "#3fb95022",
      "diffEditor.removedTextBackground": "#f0626e22",
      "diffEditor.insertedLineBackground": "#3fb95014",
      "diffEditor.removedLineBackground": "#f0626e14",
      "diffEditorGutter.insertedLineBackground": "#3fb95022",
      "diffEditorGutter.removedLineBackground": "#f0626e22",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#2b374488",
      "scrollbarSlider.hoverBackground": "#3a4756aa",
    },
  },
};

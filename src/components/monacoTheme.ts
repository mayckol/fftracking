import type { Monaco } from "@monaco-editor/react";

export const THEME = "fftrack-dark";

export function defineTheme(monaco: Monaco) {
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5d6b7a", fontStyle: "italic" },
      { token: "keyword", foreground: "7c8cff" },
      { token: "string", foreground: "4cc4c0" },
      { token: "number", foreground: "e3b341" },
    ],
    colors: {
      "editor.background": "#0a0c10",
      "editor.foreground": "#e6edf3",
      "editorGutter.background": "#0a0c10",
      "editorLineNumber.foreground": "#3d4855",
      "editorLineNumber.activeForeground": "#9aa7b4",
      "editor.lineHighlightBackground": "#0e1116",
      "editor.selectionBackground": "#2b3744",
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
  });
}

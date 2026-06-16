import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import type { FFPlugin } from "./types";

const LANG_ID = "go-mod";

function base(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function isGoMod(path: string): boolean {
  const b = base(path);
  return b === "go.mod" || b === "go.work";
}

// Tokens reuse scopes every bundled theme already colors (keyword, number,
// operator, comment, type), so no theme edits are needed. Directives anchor to
// line start; `go`/`toolchain` versions and semver tags become numbers, module
// paths become types, and `=>` (replace target) is an operator.
const GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/^\s*(module|require|replace|exclude|retract|toolchain|go|use)\b/, "keyword"],
      [/=>/, "operator"],
      [/[()]/, "delimiter"],
      [/\bv\d+\.\d+\.\d+[\w.+-]*/, "number"],
      [/\bgo\d+(?:\.\d+){1,2}\b/, "number"],
      [/\b\d+\.\d+(?:\.\d+)?\b/, "number"],
      [/[A-Za-z0-9_./~+-]+/, "type"],
    ],
  },
};

export const goModPlugin: FFPlugin = {
  manifest: {
    id: LANG_ID,
    name: "go.mod Highlight",
    description: "Syntax highlighting for Go module files — directives, versions, module paths and comments.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  language: {
    id: LANG_ID,
    matches: isGoMod,
    register(monaco: Monaco) {
      monaco.languages.register({
        id: LANG_ID,
        filenames: ["go.mod", "go.work"],
        aliases: ["Go Module", "go.mod"],
      });
      monaco.languages.setLanguageConfiguration(LANG_ID, {
        comments: { lineComment: "//" },
        brackets: [["(", ")"]],
        autoClosingPairs: [{ open: "(", close: ")" }],
      });
      monaco.languages.setMonarchTokensProvider(LANG_ID, GRAMMAR);
    },
  },
};

import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import type { FFPlugin } from "./types";

const LANG_ID = "dotenv";

// Self-contained basename: importing util.ts here would cycle (util's langOf
// imports the plugin registry, which imports this file).
function base(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// .env, .env.local, .env.production, .env.example, foo.env …
function isDotenv(path: string): boolean {
  const b = base(path);
  return b === ".env" || b.startsWith(".env.") || b.endsWith(".env");
}

// Tokens map onto scopes every bundled theme already colors (comment, keyword,
// type, string, constant, operator), so highlighting works on any theme with no
// theme edits — and any future marketplace theme that styles those scopes.
const GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/^\s*#.*$/, "comment"],
      [/^\s*$/, "white"],
      // `export KEY=…`
      [/^(\s*)(export\s+)([A-Za-z_][\w.-]*)(\s*)(=)/, ["white", "keyword", "type", "white", { token: "operator", next: "@value" }]],
      // `KEY=…`
      [/^(\s*)([A-Za-z_][\w.-]*)(\s*)(=)/, ["white", "type", "white", { token: "operator", next: "@value" }]],
      [/.*$/, ""],
    ],
    // Values are single-line. A `[/$/, @pop]` rule looks right but is dead: the
    // greedy content rule consumes to end-of-line, so Monarch's per-line loop
    // exits before `$` is ever tested and the state leaks into the next line —
    // making the following comment/key tokenize as a string. Pop at the *start*
    // of the next line instead (`^` always fires there) via @rematch, so the
    // line is re-tokenized from `root`.
    value: [
      [/^/, { token: "@rematch", next: "@pop" }],
      [/\$\{/, { token: "constant", next: "@interp" }],
      [/\$[A-Za-z_]\w*/, "constant"],
      [/"/, { token: "string", next: "@dquote" }],
      [/'/, { token: "string", next: "@squote" }],
      [/[^"'$]+/, "string"],
      [/./, "string"],
    ],
    interp: [
      [/^/, { token: "@rematch", next: "@pop" }],
      [/\}/, { token: "constant", next: "@pop" }],
      [/[^}]+/, "constant"],
    ],
    dquote: [
      [/^/, { token: "@rematch", next: "@pop" }],
      [/\$\{/, { token: "constant", next: "@interp" }],
      [/\$[A-Za-z_]\w*/, "constant"],
      [/\\./, "string.escape"],
      [/[^"\\$]+/, "string"],
      [/"/, { token: "string", next: "@pop" }],
    ],
    // Single quotes are literal in dotenv — no interpolation.
    squote: [
      [/^/, { token: "@rematch", next: "@pop" }],
      [/[^']+/, "string"],
      [/'/, { token: "string", next: "@pop" }],
    ],
  },
};

export const dotenvPlugin: FFPlugin = {
  manifest: {
    id: LANG_ID,
    name: "Dotenv Highlight",
    description: "Syntax highlighting for .env files — keys, values, interpolation and comments.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  language: {
    id: LANG_ID,
    matches: isDotenv,
    register(monaco: Monaco) {
      monaco.languages.register({
        id: LANG_ID,
        extensions: [".env"],
        filenames: [".env"],
        aliases: ["dotenv", "DotEnv", ".env"],
      });
      monaco.languages.setLanguageConfiguration(LANG_ID, {
        comments: { lineComment: "#" },
        autoClosingPairs: [
          { open: '"', close: '"' },
          { open: "'", close: "'" },
          { open: "{", close: "}" },
        ],
      });
      monaco.languages.setMonarchTokensProvider(LANG_ID, GRAMMAR);
    },
  },
};

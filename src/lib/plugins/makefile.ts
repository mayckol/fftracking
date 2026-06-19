import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import type { FFPlugin } from "./types";

const LANG_ID = "makefile";

function base(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function isMakefile(path: string): boolean {
  const b = base(path);
  return /^(GNUmakefile|[Mm]akefile)$/.test(b) || /\.(mk|make)$/.test(b);
}

// GNU Make's built-in functions, highlighted as keywords inside $(...) / ${...}.
const FUNCTIONS =
  /\b(shell|wildcard|patsubst|subst|foreach|filter|filter-out|sort|word|words|wordlist|firstword|lastword|dir|notdir|suffix|basename|addsuffix|addprefix|join|realpath|abspath|if|or|and|call|eval|file|origin|flavor|value|error|warning|info|guile)\b/;

// Scopes reuse what every bundled theme already colors (comment, keyword, type,
// variable, operator, string). Targets and assignment names become types,
// directives/functions keywords, `$(...)`/automatic vars variables.
const GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      // Directives, conditionals and special targets at line start.
      [
        /^\s*(ifeq|ifneq|ifdef|ifndef|else|endif|-?include|sinclude|define|endef|export|unexport|override|private|vpath|\.PHONY|\.DEFAULT|\.PRECIOUS|\.INTERMEDIATE|\.SECONDARY|\.SECONDEXPANSION|\.SUFFIXES|\.DELETE_ON_ERROR|\.IGNORE|\.SILENT|\.NOTPARALLEL|\.ONESHELL|\.POSIX)\b/,
        "keyword",
      ],
      // Variable assignment: NAME followed by = := ?= += !=
      [/^[A-Za-z_][\w.-]*(?=\s*[:+?!]?=)/, "type.identifier"],
      [/[:+?!]?=/, "operator"],
      // Target line: name(s) before a single colon (not the := assignment).
      [/^[^\t:#=][^:#=]*(?=:(?!=))/, "type"],
      [/:/, "delimiter"],
      // Automatic variables and escaped $$.
      [/\$[@<^?*+%|]/, "variable.predefined"],
      [/\$\$/, "string.escape"],
      { include: "@ref" },
      [/"/, { token: "string.quote", next: "@dstring" }],
      [/'/, { token: "string.quote", next: "@sstring" }],
    ],
    // $(...) / ${...} variable and function references, nesting-aware.
    ref: [[/\$[({]/, { token: "variable", next: "@inref" }]],
    inref: [
      [FUNCTIONS, "keyword"],
      [/\$[({]/, { token: "variable", next: "@inref" }],
      [/[)}]/, { token: "variable", next: "@pop" }],
      [/[A-Za-z_][\w.-]*/, "variable"],
      [/[^)}({]+/, "variable"],
    ],
    dstring: [
      [/\$[({]/, { token: "variable", next: "@inref" }],
      [/[^"$]+/, "string"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    sstring: [
      [/[^']+/, "string"],
      [/'/, { token: "string.quote", next: "@pop" }],
    ],
  },
};

export const makefilePlugin: FFPlugin = {
  manifest: {
    id: LANG_ID,
    name: "Makefile Highlight",
    description: "Syntax highlighting for Makefiles — targets, variables, directives, functions and recipes.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  language: {
    id: LANG_ID,
    matches: isMakefile,
    register(monaco: Monaco) {
      monaco.languages.register({
        id: LANG_ID,
        filenames: ["Makefile", "makefile", "GNUmakefile"],
        extensions: [".mk", ".make"],
        aliases: ["Makefile", "make"],
      });
      monaco.languages.setLanguageConfiguration(LANG_ID, {
        comments: { lineComment: "#" },
        brackets: [
          ["(", ")"],
          ["{", "}"],
        ],
        autoClosingPairs: [
          { open: "(", close: ")" },
          { open: "{", close: "}" },
          { open: '"', close: '"' },
          { open: "'", close: "'" },
        ],
      });
      monaco.languages.setMonarchTokensProvider(LANG_ID, GRAMMAR);
    },
  },
};

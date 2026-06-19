import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import type { FFPlugin } from "./types";

const LANG_ID = "vue";

function base(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Vue SFC grammar: the three top-level blocks embed Monaco's built-in languages
// — <template> → html, <script>/<script setup> → typescript (handles JS too),
// <style> → css. Mirrors the embedding mechanics of Monaco's own html grammar
// (enter via nextEmbedded on `>`, leave via @rematch+@pop on the close tag).
const GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".vue",
  tokenizer: {
    root: [
      [/<!--/, "comment", "@comment"],
      [/(<)(template)(?=[\s/>])/, ["delimiter", { token: "tag", next: "@templateTag" }]],
      [/(<)(script)(?=[\s/>])/, ["delimiter", { token: "tag", next: "@scriptTag" }]],
      [/(<)(style)(?=[\s/>])/, ["delimiter", { token: "tag", next: "@styleTag" }]],
      [/(<\/)((?:[\w-]+:)?[\w-]+)/, ["delimiter", { token: "tag", next: "@closeTag" }]],
      [/[^<]+/, ""],
      [/</, ""],
    ],
    comment: [
      [/-->/, "comment", "@pop"],
      [/[^-]+/, "comment"],
      [/./, "comment"],
    ],
    closeTag: [[/>/, { token: "delimiter", next: "@pop" }]],
    attrs: [
      [/[ \t\r\n]+/, ""],
      [/(setup|scoped|module)(?=[\s/>=])/, "attribute.name"],
      [/[:@#.[\]\w-]+(?=\s*=)/, "attribute.name"],
      [/=/, "delimiter"],
      [/"[^"]*"/, "attribute.value"],
      [/'[^']*'/, "attribute.value"],
      [/[:@#.[\]\w-]+/, "attribute.name"],
    ],
    templateTag: [
      { include: "@attrs" },
      [/\/>/, { token: "delimiter", next: "@pop" }],
      [/>/, { token: "delimiter", next: "@templateBody", nextEmbedded: "html" }],
      [/(<\/)(template\s*)(>)/, ["delimiter", "tag", { token: "delimiter", next: "@pop" }]],
    ],
    templateBody: [
      [/<\/template/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
      [/[^<]+/, ""],
      [/</, ""],
    ],
    scriptTag: [
      { include: "@attrs" },
      [/\/>/, { token: "delimiter", next: "@pop" }],
      [/>/, { token: "delimiter", next: "@scriptBody", nextEmbedded: "typescript" }],
      [/(<\/)(script\s*)(>)/, ["delimiter", "tag", { token: "delimiter", next: "@pop" }]],
    ],
    scriptBody: [
      [/<\/script/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
      [/[^<]+/, ""],
      [/</, ""],
    ],
    styleTag: [
      { include: "@attrs" },
      [/\/>/, { token: "delimiter", next: "@pop" }],
      [/>/, { token: "delimiter", next: "@styleBody", nextEmbedded: "css" }],
      [/(<\/)(style\s*)(>)/, ["delimiter", "tag", { token: "delimiter", next: "@pop" }]],
    ],
    styleBody: [
      [/<\/style/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
      [/[^<]+/, ""],
      [/</, ""],
    ],
  },
};

export const vuePlugin: FFPlugin = {
  manifest: {
    id: LANG_ID,
    name: "Vue Highlight",
    description: "Syntax highlighting for Vue single-file components — <template> (HTML), <script>/<script setup> (JS/TS) and <style> (CSS).",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  language: {
    id: LANG_ID,
    matches: (path) => base(path).toLowerCase().endsWith(".vue"),
    register(monaco: Monaco) {
      monaco.languages.register({ id: LANG_ID, extensions: [".vue"], aliases: ["Vue", "vue"] });
      monaco.languages.setLanguageConfiguration(LANG_ID, {
        comments: { blockComment: ["<!--", "-->"], lineComment: "//" },
        brackets: [
          ["<", ">"],
          ["{", "}"],
          ["[", "]"],
          ["(", ")"],
        ],
        autoClosingPairs: [
          { open: "{", close: "}" },
          { open: "[", close: "]" },
          { open: "(", close: ")" },
          { open: '"', close: '"' },
          { open: "'", close: "'" },
          { open: "`", close: "`" },
        ],
      });
      monaco.languages.setMonarchTokensProvider(LANG_ID, GRAMMAR);
    },
  },
};

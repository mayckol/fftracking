import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import type { FFPlugin } from "./types";

// Dedicated Monaco languages for React files so JSX gets its own grammar without
// disturbing the plain "typescript"/"javascript" tokenizer. langOf routes
// .tsx→typescriptreact and .jsx→javascriptreact when this plugin is enabled
// (registry.languageForPath), and lsp.ts registers the vtsls providers for these
// ids too, so .tsx/.jsx keep full language-server support.
const TSX = "typescriptreact";
const JSX = "javascriptreact";

function base(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

const TS_KEYWORDS = [
  "abstract", "as", "asserts", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "debugger", "declare", "default", "delete", "do", "else",
  "enum", "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "infer", "instanceof", "interface", "is", "keyof",
  "let", "namespace", "new", "of", "out", "override", "package", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static",
  "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void",
  "while", "with", "yield",
];
const JS_KEYWORDS = TS_KEYWORDS.filter(
  (k) =>
    ![
      "abstract", "as", "asserts", "declare", "enum", "implements", "infer",
      "interface", "is", "keyof", "namespace", "out", "override", "private",
      "protected", "public", "readonly", "satisfies", "type",
    ].includes(k),
);

const LITERALS = ["true", "false", "null", "undefined", "NaN", "Infinity"];
const TYPE_KEYWORDS = [
  "any", "boolean", "never", "number", "object", "string", "symbol", "unknown",
  "bigint", "this",
];

// A pragmatic JS/TS + JSX grammar. JSX detection is heuristic (Monarch is
// regular, so generics vs JSX can't be told apart perfectly): `<Tag`, `</`, and
// `<>` in expression-ish positions open tag mode. Good enough for highlighting;
// it never affects the language server (vtsls owns semantics).
function grammar(typescript: boolean): languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: typescript ? ".tsx" : ".jsx",
    keywords: typescript ? TS_KEYWORDS : JS_KEYWORDS,
    typeKeywords: typescript ? TYPE_KEYWORDS : [],
    literals: LITERALS,
    operators: [
      "<=", ">=", "==", "!=", "===", "!==", "=>", "+", "-", "**", "*", "/", "%",
      "++", "--", "<<", "</", ">>", ">>>", "&", "|", "^", "!", "~", "&&", "||",
      "??", "?", ":", "=", "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=",
      ">>>=", "&=", "|=", "^=", "@",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/,
    digits: /\d+(_+\d+)*/,
    tokenizer: {
      root: [{ include: "common" }],

      common: [
        // JSX: an element/fragment in expression position. The lookahead keeps a
        // generic call like `foo<Bar>(x)` out of tag mode (it requires `<` then a
        // tag name then a tag-ish continuation, or a fragment `<>`).
        [/<(?=[A-Za-z][\w.-]*(\s|\/?>|$))/, { token: "delimiter.angle", next: "@jsxTag" }],
        [/<(?=>)/, { token: "delimiter.angle", next: "@jsxTag" }],

        [/[a-z_$][\w$]*(?=\s*\()/, { cases: { "@keywords": "keyword", "@default": "function.call" } }],
        [/[A-Z][\w$]*/, { cases: { "@typeKeywords": "type", "@default": "type.identifier" } }],
        [
          /[a-z_$][\w$]*/,
          { cases: { "@keywords": "keyword", "@literals": "constant", "@default": "identifier" } },
        ],

        { include: "@whitespace" },

        // Regex vs division: only treat `/` as regex where a value can't precede.
        [/\/(?=([^\\/]|\\.)+\/([dgimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/, { token: "regexp", next: "@regexp" }],

        [/[{}()[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],

        // Specific bases + floats before the bare-integer rule, else `0x1F` and
        // `3.14` get eaten as plain integers.
        [/0[xX][0-9a-fA-F_]+[nN]?/, "number.hex"],
        [/0[oO][0-7_]+[nN]?/, "number.octal"],
        [/0[bB][01_]+[nN]?/, "number.binary"],
        [/(@digits)\.(@digits)([eE][-+]?(@digits))?/, "number.float"],
        [/(@digits)[eE][-+]?(@digits)/, "number.float"],
        [/(@digits)[nN]?/, "number"],

        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", next: "@dstring" }],
        [/'/, { token: "string.quote", next: "@sstring" }],
        [/`/, { token: "string.quote", next: "@template" }],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@jsdoc"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      jsdoc: [
        [/[^/*]+/, "comment.doc"],
        [/@\w+/, "comment.doc.keyword"],
        [/\*\//, "comment.doc", "@pop"],
        [/[/*]/, "comment.doc"],
      ],

      dstring: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      sstring: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, { token: "string.quote", next: "@pop" }],
      ],
      template: [
        [/\$\{/, { token: "delimiter.bracket", next: "@templateExpr" }],
        [/[^\\`$]+/, "string"],
        [/@escapes/, "string.escape"],
        [/`/, { token: "string.quote", next: "@pop" }],
      ],
      templateExpr: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        { include: "common" },
      ],
      regexp: [
        [/[^\\/[]+/, "regexp"],
        [/\[/, { token: "regexp.escape.control", next: "@regexpClass" }],
        [/\\./, "regexp.escape"],
        [/\/[dgimsuy]*/, { token: "regexp", next: "@pop" }],
      ],
      regexpClass: [
        [/[^\\\]]+/, "regexp"],
        [/\\./, "regexp.escape"],
        [/\]/, { token: "regexp.escape.control", next: "@pop" }],
      ],

      // <tag ...attrs...> | </tag> | <> | self-closing />
      jsxTag: [
        [/[ \t\r\n]+/, ""],
        [/(\/)?>/, { token: "delimiter.angle", next: "@pop" }],
        [/\//, "delimiter.angle"],
        [/[A-Za-z_$][\w$]*/, "tag", "@jsxAttrs"],
        [/[.:-]/, "tag"],
        [/>/, { token: "delimiter.angle", next: "@pop" }],
      ],
      jsxAttrs: [
        [/[ \t\r\n]+/, ""],
        [/(\/)?>/, { token: "delimiter.angle", next: "@popall" }],
        [/[A-Za-z_$][\w$-]*(?=\s*=)/, "attribute.name"],
        [/=/, "delimiter"],
        [/"([^"]*)"/, "attribute.value"],
        [/'([^']*)'/, "attribute.value"],
        [/\{/, { token: "delimiter.bracket", next: "@jsxExpr" }],
        [/[A-Za-z_$][\w$-]*/, "attribute.name"],
        [/[.:-]/, "tag"],
      ],
      jsxExpr: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        { include: "common" },
      ],
    },
  };
}

function isReact(path: string, ext: "tsx" | "jsx"): boolean {
  return base(path).toLowerCase().endsWith("." + ext);
}

function registerLang(monaco: Monaco, id: string, ext: string, typescript: boolean) {
  monaco.languages.register({ id, extensions: [ext], aliases: id === TSX ? ["TSX", "tsx"] : ["JSX", "jsx"] });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
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
      { open: "/*", close: "*/", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
      { open: "<", close: ">" },
    ],
  });
  monaco.languages.setMonarchTokensProvider(id, grammar(typescript));
}

export const jsxPlugin: FFPlugin = {
  manifest: {
    id: "jsx",
    name: "JSX / React Highlight",
    description: "JSX-aware syntax highlighting for React .jsx and .tsx files — element tags, attributes and embedded expressions.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    defaultInstalled: true,
  },
  language: {
    // langOf only routes when this plugin is enabled; the registry registers
    // both ids on first activation. idForPath picks the right id per extension.
    id: TSX,
    matches: (path) => isReact(path, "tsx") || isReact(path, "jsx"),
    idForPath: (path) => (isReact(path, "tsx") ? TSX : isReact(path, "jsx") ? JSX : null),
    register(monaco: Monaco) {
      registerLang(monaco, TSX, ".tsx", true);
      registerLang(monaco, JSX, ".jsx", false);
    },
  },
};

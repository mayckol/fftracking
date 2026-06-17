// "Implement interface": parse an interface declaration out of
// its source file and emit a type + method stubs that satisfy it. Textual on
// purpose — no type checker here. Exported (capitalized) bare identifiers in
// signatures are package-qualified when the interface lives in another
// package; gopls organize-imports resolves the qualifier to an import after
// the stub is inserted.

import { pkgNameOf } from "./goimports";

export interface StubArgs {
  /** Full text of the file declaring the interface. */
  source: string;
  ifaceName: string;
  /** 1-based line where the symbol's declaration starts (from workspace/symbol). */
  line: number;
  typeName: string;
  /** Package qualifier for the interface's exported types ("" = same package). */
  qualifier: string;
  /** Import path of the interface's package (resolves `qualifier`). */
  ifacePkgPath: string;
  /** Emit the `type X struct{}` line above the methods. */
  createType: boolean;
}

export interface NeededImport {
  path: string;
  /** Qualifier the stub text uses (may be the interface file's alias). */
  pkg: string;
  /** The package's canonical name — what a plain (un-aliased) import binds. */
  name: string;
}

export interface StubResult {
  text: string;
  /** Imports the stub's signatures reference, resolved through the interface
   *  file's own import block (alias-aware). */
  imports: NeededImport[];
  /** Embedded interfaces that were skipped (their methods aren't expanded). */
  skippedEmbeds: string[];
}

/** Qualifier → import path map of a Go file's import declarations. */
export function importMapOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (alias: string | undefined, path: string) => {
    if (alias === "." || alias === "_") return;
    out.set(alias ?? pkgNameOf(path), path);
  };
  const single = /^import\s+(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/gm;
  for (let m; (m = single.exec(source)); ) add(m[1] || undefined, m[2]);
  const block = /^import\s*\(([\s\S]*?)^\)/gm;
  for (let b; (b = block.exec(source)); ) {
    const line = /^\s*(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/gm;
    for (let m; (m = line.exec(b[1])); ) add(m[1] || undefined, m[2]);
  }
  return out;
}

/** First `package X` clause of a Go file — the qualifier its exported types
 *  need from the outside. */
export function packageNameOf(source: string): string {
  const m = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/m.exec(source);
  return m?.[1] ?? "";
}

// Strip line/block comments without touching string literals — good enough for
// signature lines, where strings essentially never appear.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
}

/** Extracts the `{ ... }` body of `type <name> interface` starting the search
 *  at `line` (1-based), brace-matched. Null when not found. */
function interfaceBody(source: string, name: string, line: number): string | null {
  const lines = source.split("\n");
  const declRx = new RegExp(`type\\s+${name}(?:\\[[^\\]]*\\])?\\s+interface\\b`);
  // The symbol range usually starts on the decl line; scan a little around it
  // (grouped `type (...)` blocks shift it), then fall back to the whole file.
  const order = [
    ...Array.from({ length: 6 }, (_, i) => line - 1 + i),
    ...lines.map((_, i) => i),
  ];
  let at = -1;
  for (const i of order) {
    if (i >= 0 && i < lines.length && declRx.test(stripComments(lines[i]))) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const text = lines.slice(at).join("\n");
  const open = text.indexOf("{", text.search(declRx));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

interface Method {
  name: string;
  /** Signature after the name: "(params) results". */
  sig: string;
}

/** Splits an interface body into method signatures and embedded interfaces.
 *  Multi-line signatures are joined by paren balance. */
function parseBody(body: string): { methods: Method[]; embeds: string[] } {
  const methods: Method[] = [];
  const embeds: string[] = [];
  let buf = "";
  let depth = 0;
  for (const raw of stripComments(body).split("\n")) {
    const t = raw.trim();
    if (!t && depth === 0) continue;
    buf = buf ? `${buf} ${t}` : t;
    for (const ch of t) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth > 0) continue;
    // Multi-line signatures got joined with spaces — normalize the paren
    // spacing and drop trailing commas (valid only before a newline in Go).
    const entry = buf
      .trim()
      .replace(/\(\s+/g, "(")
      .replace(/\s*,?\s*\)/g, ")");
    buf = "";
    if (!entry) continue;
    const m = /^([A-Za-z_]\w*)\s*(\(.*)$/.exec(entry);
    if (m) methods.push({ name: m[1], sig: m[2] });
    else if (/^[A-Za-z_][\w.]*(\[[^\]]*\])?$/.test(entry)) embeds.push(entry);
  }
  return { methods, embeds };
}

// Exported bare identifiers in a signature belong to the interface's package —
// qualify them. Already-qualified (`pkg.X`) names are guarded by the
// look-behind character class.
function qualify(sig: string, qualifier: string): string {
  if (!qualifier) return sig;
  return sig.replace(/(^|[^.\w])([A-Z][A-Za-z0-9_]*)\b/g, `$1${qualifier}.$2`);
}

export function buildStubs(args: StubArgs): StubResult | null {
  const body = interfaceBody(args.source, args.ifaceName, args.line);
  if (body == null) return null;
  const { methods, embeds } = parseBody(body);
  const recv = args.typeName[0]?.toLowerCase() || "x";

  const parts: string[] = [];
  if (args.createType) parts.push(`type ${args.typeName} struct{}`);
  for (const e of embeds) {
    parts.push(`// TODO: ${args.ifaceName} embeds ${e} — implement its methods too`);
  }
  for (const m of methods) {
    parts.push(
      `func (${recv} ${args.typeName}) ${m.name}${qualify(m.sig, args.qualifier)} {\n` +
        `\t//TODO implement me\n` +
        `\tpanic("implement me")\n` +
        `}`,
    );
  }
  if (parts.length === 0) return null;
  const text = parts.join("\n\n");

  // Every `pkg.Type` the signatures reference needs an import in the target
  // file: our own qualifier maps to the interface's package, the rest resolve
  // through the interface file's import block (alias-aware).
  const ifaceImports = importMapOf(args.source);
  const imports: NeededImport[] = [];
  const seen = new Set<string>();
  const qualRx = /(^|[^.\w])([A-Za-z_]\w*)\.[A-Za-z_]/g;
  for (let m; (m = qualRx.exec(text)); ) {
    const q = m[2];
    if (seen.has(q)) continue;
    seen.add(q);
    if (q === args.qualifier && args.ifacePkgPath) {
      // Own package: `q` is the real package name (parsed from its source).
      imports.push({ path: args.ifacePkgPath, pkg: q, name: q });
    } else if (ifaceImports.has(q)) {
      const path = ifaceImports.get(q)!;
      imports.push({ path, pkg: q, name: pkgNameOf(path) });
    }
  }
  return { text, imports, skippedEmbeds: embeds };
}

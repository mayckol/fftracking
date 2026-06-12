// Go import-block intelligence: parses a file's import section, plans where a
// new import belongs (used by completion auto-import), and regroups the whole
// block according to the workspace's .golangci.yml gci/goimports config.

import type * as Monaco from "monaco-editor";
import { api } from "./ipc";
import type { GoImportStyle } from "./uiPrefs";

type Json = any;

export interface ImportEntry {
  alias: string | null;
  path: string;
  line: number;
}

export interface ImportLayout {
  pkgLine: number;
  blockOpen: number;
  blockClose: number;
  lastSingle: number;
  entries: ImportEntry[];
  /** Block entries split by blank lines — the file's own grouping scheme. */
  groups: ImportEntry[][];
  /** Block contains lines we don't understand (comments, cgo) — rewriting
   *  the block wholesale would lose them, so regrouping must bail. */
  opaque: boolean;
}

const IMPORT_SCAN_LIMIT = 400;

export function parseImports(model: Monaco.editor.ITextModel): ImportLayout {
  const max = Math.min(model.getLineCount(), IMPORT_SCAN_LIMIT);
  const layout: ImportLayout = {
    pkgLine: 0,
    blockOpen: 0,
    blockClose: 0,
    lastSingle: 0,
    entries: [],
    groups: [],
    opaque: false,
  };
  let inBlock = false;
  let firstBlockDone = false;
  let current: ImportEntry[] = [];
  for (let i = 1; i <= max; i++) {
    const t = model.getLineContent(i);
    if (inBlock) {
      if (/^\s*\)/.test(t)) {
        if (!firstBlockDone) {
          layout.blockClose = i;
          if (current.length) layout.groups.push(current);
          current = [];
          firstBlockDone = true;
        }
        inBlock = false;
        continue;
      }
      const m = t.match(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/);
      if (m) {
        const e = { alias: m[1] ?? null, path: m[2], line: i };
        layout.entries.push(e);
        if (!firstBlockDone) current.push(e);
      } else if (!t.trim()) {
        if (!firstBlockDone && current.length) {
          layout.groups.push(current);
          current = [];
        }
      } else if (!firstBlockDone) {
        layout.opaque = true;
      }
      continue;
    }
    if (/^package\s/.test(t)) {
      layout.pkgLine = i;
    } else if (/^import\s*\(/.test(t)) {
      if (!firstBlockDone) layout.blockOpen = i;
      inBlock = true;
    } else {
      const single = t.match(/^import\s+(?:([\w.]+)\s+)?"([^"]+)"/);
      if (single) {
        layout.entries.push({ alias: single[1] ?? null, path: single[2], line: i });
        layout.lastSingle = i;
      } else if (/^(func|type|const|var)\b/.test(t)) {
        break; // imports always precede declarations
      }
    }
  }
  return layout;
}

// Last path segment as the package qualifier; handles /v2 module suffixes and
// gopkg.in-style name.vN. Heuristic — wrong only when a package's name differs
// from its directory, which organize-imports-on-format then cleans up.
export function pkgNameOf(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts.pop() || importPath;
  if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
  return last.replace(/\.v\d+$/, "");
}

function sharedSegments(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

// Stdlib import paths have no dot in the first segment ("fmt", "net/http").
const isStdPath = (p: string) => !p.split("/")[0].includes(".");

const editAt = (line: number, text: string): Json => ({
  range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
  text,
});

// ---------------------------------------------------------------------------
// .golangci.yml support

export interface GciSection {
  kind: "standard" | "default" | "prefix" | "blank" | "dot" | "localmodule";
  prefix?: string;
}

export interface GoImportsConfig {
  /** Section order from gci (or synthesized from goimports local-prefixes);
   *  null when the workspace has no usable import-grouping config. */
  sections: GciSection[] | null;
  /** Module path from go.mod, for the gci `localmodule` section. */
  module: string | null;
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

function parseSection(s: string): GciSection | null {
  const p = s.match(/^prefix\((.+)\)$/i);
  if (p) return { kind: "prefix", prefix: unquote(p[1].trim()) };
  const k = s.toLowerCase();
  if (k === "standard" || k === "default" || k === "blank" || k === "dot" || k === "localmodule")
    return { kind: k };
  return null; // alias/unknown sections aren't representable; imports fall through to default
}

/** Targeted extraction of gci `sections` (any nesting depth — covers both v1
 *  linters-settings and v2 formatters.settings) with goimports
 *  `local-prefixes` as fallback. Not a YAML parser; good enough for the two
 *  keys we need. */
export function parseGolangciImports(text: string): GciSection[] | null {
  const lines = text.split("\n").map((l) => l.replace(/\t/g, "  "));

  const listUnder = (idx: number): string[] => {
    const base = indentOf(lines[idx]);
    const out: string[] = [];
    for (let j = idx + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (indentOf(l) <= base) break;
      const m = l.match(/^\s*-\s*(.+?)\s*(?:#.*)?$/);
      if (m) out.push(unquote(m[1].trim()));
      else break;
    }
    return out;
  };

  const gci = lines.findIndex((l) => /^\s*gci:\s*$/.test(l));
  if (gci >= 0) {
    const base = indentOf(lines[gci]);
    for (let i = gci + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && indentOf(l) <= base) break;
      if (/^\s*sections:\s*$/.test(l)) {
        const sections = listUnder(i).map(parseSection).filter((s): s is GciSection => s !== null);
        if (sections.length) return sections;
        break;
      }
    }
  }

  const gi = lines.findIndex((l) => /^\s*goimports:\s*$/.test(l));
  if (gi >= 0) {
    const base = indentOf(lines[gi]);
    for (let i = gi + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && indentOf(l) <= base) break;
      const inlineVal = l.match(/^\s*local-prefixes:\s*(.+?)\s*$/);
      const prefixes = inlineVal
        ? unquote(inlineVal[1]).split(",").map((s) => s.trim()).filter(Boolean)
        : /^\s*local-prefixes:\s*$/.test(l)
          ? listUnder(i)
          : null;
      if (prefixes?.length) {
        // goimports semantics: std, everything else, then local groups last.
        return [
          { kind: "standard" },
          { kind: "default" },
          ...prefixes.map((p): GciSection => ({ kind: "prefix", prefix: p })),
        ];
      }
    }
  }
  return null;
}

// Config re-read after TTL so .golangci.yml edits take effect without
// restarting; the sync cache keeps the last good value in the meantime.
const CFG_TTL_MS = 30_000;
const cfgPending = new Map<string, { p: Promise<GoImportsConfig>; at: number }>();
const cfgReady = new Map<string, GoImportsConfig>();

export function loadGoImportsConfig(root: string): Promise<GoImportsConfig> {
  const cached = cfgPending.get(root);
  if (cached && Date.now() - cached.at < CFG_TTL_MS) return cached.p;
  const p = (async () => {
    const read = (f: string) => api.readTextFile(`${root}/${f}`).catch(() => null);
    const [yml, yaml, gomod] = await Promise.all([
      read(".golangci.yml"),
      read(".golangci.yaml"),
      read("go.mod"),
    ]);
    const text = yml || yaml;
    const cfg: GoImportsConfig = {
      sections: text ? parseGolangciImports(text) : null,
      module: gomod?.match(/^module\s+(\S+)/m)?.[1] ?? null,
    };
    cfgReady.set(root, cfg);
    return cfg;
  })();
  cfgPending.set(root, { p, at: Date.now() });
  return p;
}

/** Synchronous view of the config for hot paths (completion); null until the
 *  async load kicked off by loadGoImportsConfig settles. */
export function cachedGoImportsConfig(root: string): GoImportsConfig | null {
  return cfgReady.get(root) ?? null;
}

/** Which configured section `path` belongs to; -1 when nothing matches (no
 *  default section configured). Blank/dot match on alias, then stdlib, then
 *  the most specific prefix/localmodule. */
function sectionIndex(path: string, alias: string | null, cfg: GoImportsConfig): number {
  const ss = cfg.sections!;
  let std = -1;
  let def = -1;
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (s.kind === "blank" && alias === "_") return i;
    if (s.kind === "dot" && alias === ".") return i;
    if (s.kind === "standard") std = i;
    else if (s.kind === "default") def = i;
    else if (s.kind === "prefix" && s.prefix && path.startsWith(s.prefix)) {
      if (s.prefix.length > bestLen) {
        bestLen = s.prefix.length;
        best = i;
      }
    } else if (
      s.kind === "localmodule" &&
      cfg.module &&
      (path === cfg.module || path.startsWith(cfg.module + "/"))
    ) {
      if (cfg.module.length > bestLen) {
        bestLen = cfg.module.length;
        best = i;
      }
    }
  }
  if (std !== -1 && isStdPath(path)) return std;
  if (best !== -1) return best;
  return def;
}

// ---------------------------------------------------------------------------
// Placement of a single new import (completion auto-import)

/** Insert per the configured gci sections: alphabetically among entries of
 *  the same section, or opening the section in order when it's empty. */
function gciInsertEdit(layout: ImportLayout, path: string, cfg: GoImportsConfig): Json {
  const idx = sectionIndex(path, null, cfg);
  const flat = layout.groups.flat();
  const indexed = flat.map((e) => ({ e, i: sectionIndex(e.path, e.alias, cfg) }));
  const same = indexed.filter((x) => x.i === idx && idx >= 0).map((x) => x.e);
  if (same.length) {
    const before = same.find((e) => e.path > path);
    if (before) return editAt(before.line, `\t"${path}"\n`);
    return editAt(same[same.length - 1].line + 1, `\t"${path}"\n`);
  }
  // Section currently empty: open it before the first entry of any later
  // section (unmatched entries sort last), else at the bottom of the block.
  const later = indexed
    .filter((x) => x.i > idx || x.i < 0)
    .sort((a, b) => a.e.line - b.e.line)[0];
  if (later) return editAt(later.e.line, `\t"${path}"\n\n`);
  return editAt(layout.blockClose, `\n\t"${path}"\n`);
}

/** No-config fallback: the group whose members share the longest path prefix
 *  with the new import (≥3 segments ≈ same module/sdk), else the first
 *  non-stdlib group; alphabetical within the group. Mirrors whatever grouping
 *  the file already uses. */
function heuristicInsertEdit(layout: ImportLayout, path: string): Json {
  const std = isStdPath(path);
  let target: ImportEntry[] | null = null;
  if (layout.groups.length) {
    const stdGroup = (g: ImportEntry[]) => g.every((e) => isStdPath(e.path));
    if (std) {
      target = layout.groups.find(stdGroup) ?? null;
    } else {
      let bestScore = -1;
      let best: ImportEntry[] | null = null;
      for (const g of layout.groups) {
        if (stdGroup(g)) continue;
        const score = Math.max(...g.map((e) => sharedSegments(path, e.path)));
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
      target = bestScore >= 3 ? best : (layout.groups.find((g) => !stdGroup(g)) ?? null);
    }
  }
  if (!target) {
    if (std) return editAt(layout.blockOpen + 1, `\t"${path}"\n\n`);
    return editAt(layout.blockClose, `\n\t"${path}"\n`);
  }
  const before = target.find((e) => e.path > path);
  if (before) return editAt(before.line, `\t"${path}"\n`);
  return editAt(target[target.length - 1].line + 1, `\t"${path}"\n`);
}

/** Flat style: the whole block is one alphabetical list. */
function flatInsertEdit(layout: ImportLayout, path: string): Json {
  const flat = layout.groups.flat();
  const before = flat.find((e) => e.path > path);
  if (before) return editAt(before.line, `\t"${path}"\n`);
  if (flat.length) return editAt(flat[flat.length - 1].line + 1, `\t"${path}"\n`);
  return editAt(layout.blockOpen + 1, `\t"${path}"\n`);
}

export interface ImportPlan {
  /** Qualifier to type before the symbol ("" for dot imports). */
  qualifier: string;
  edit: Json | null;
}

/** Parses the file's imports once and plans per-path: reuse the existing
 *  alias when the path is already imported (no edit), un-blank `_` imports,
 *  or insert a new import per the chosen style. Null when the file has no
 *  anchor to attach an import to. */
export function importPlanner(
  model: Monaco.editor.ITextModel,
  cfg: GoImportsConfig | null,
  style: GoImportStyle,
) {
  const layout = parseImports(model);
  return (path: string, pkg: string): ImportPlan | null => {
    const existing = layout.entries.find((e) => e.path === path);
    if (existing) {
      if (existing.alias === ".") return { qualifier: "", edit: null };
      if (existing.alias === "_") {
        const t = model.getLineContent(existing.line);
        return {
          qualifier: pkg,
          edit: {
            range: {
              startLineNumber: existing.line,
              startColumn: 1,
              endLineNumber: existing.line,
              endColumn: t.length + 1,
            },
            text: t.replace(/_\s+/, ""),
          },
        };
      }
      return { qualifier: existing.alias ?? pkg, edit: null };
    }
    if (layout.blockOpen && layout.blockClose) {
      const edit =
        style === "flat"
          ? flatInsertEdit(layout, path)
          : style === "golangci" && cfg?.sections?.length
            ? gciInsertEdit(layout, path, cfg)
            : heuristicInsertEdit(layout, path);
      return { qualifier: pkg, edit };
    }
    if (layout.lastSingle)
      return { qualifier: pkg, edit: editAt(layout.lastSingle + 1, `import "${path}"\n`) };
    if (layout.pkgLine)
      return { qualifier: pkg, edit: editAt(layout.pkgLine + 1, `\nimport "${path}"\n`) };
    return null;
  };
}

// ---------------------------------------------------------------------------
// Whole-block regrouping (organize-imports-on-save per .golangci.yml)

const byPath = (a: ImportEntry, z: ImportEntry) =>
  a.path < z.path ? -1 : a.path > z.path ? 1 : 0;

/** Rewrites the import block per the chosen style: golangci = configured
 *  section order; grouped = keep the file's groups, sort within each; flat =
 *  one alphabetical group. Null when there's nothing to do or the block
 *  contains lines we'd lose (comments, cgo). */
export function regroupImportsEdit(
  model: Monaco.editor.ITextModel,
  cfg: GoImportsConfig | null,
  style: GoImportStyle,
): Json | null {
  const layout = parseImports(model);
  if (!layout.blockOpen || !layout.blockClose || layout.opaque) return null;
  const entries = layout.groups.flat();
  if (!entries.length) return null;

  let ordered: ImportEntry[][];
  if (style === "flat") {
    ordered = [[...entries].sort(byPath)];
  } else if (style === "golangci" && cfg?.sections?.length) {
    const buckets: ImportEntry[][] = cfg.sections.map(() => []);
    const unmatched: ImportEntry[] = [];
    for (const e of entries) {
      const i = sectionIndex(e.path, e.alias, cfg);
      if (i >= 0) buckets[i].push(e);
      else unmatched.push(e);
    }
    ordered = buckets.filter((b) => b.length);
    if (unmatched.length) ordered.push(unmatched);
    for (const b of ordered) b.sort(byPath);
  } else {
    // grouped (or golangci without a config): keep group membership, sort
    // each group alphabetically.
    ordered = layout.groups.map((g) => [...g].sort(byPath));
  }

  const text =
    ordered
      .map((g) => g.map((e) => `\t${e.alias ? e.alias + " " : ""}"${e.path}"`).join("\n"))
      .join("\n\n") + "\n";
  const blockRange = {
    startLineNumber: layout.blockOpen + 1,
    startColumn: 1,
    endLineNumber: layout.blockClose,
    endColumn: 1,
  };
  if (model.getValueInRange(blockRange) === text) return null;
  return { range: blockRange, text };
}

/** Loads the workspace config (only needed for golangci style) and applies
 *  the regroup to `model` as a single undo step. */
export async function applyImportGrouping(
  model: Monaco.editor.ITextModel,
  root: string,
  style: GoImportStyle,
): Promise<void> {
  const cfg = style === "golangci" ? await loadGoImportsConfig(root) : null;
  const edit = regroupImportsEdit(model, cfg, style);
  if (edit) model.pushEditOperations([], [edit], () => null);
}

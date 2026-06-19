/// <reference lib="webworker" />
// Spell-check worker: owns one Typo (typo-js) instance per language so the
// dictionary parse and every lookup stay off the UI thread. typo-js applies
// Hunspell affix rules on demand — unlike nspell it never pre-expands all
// forms, so pt-br (which would explode to ~10.5M forms and blow V8's property
// cap) loads fine. Pure JS, so no wasm/loader plumbing.
import Typo from "typo-js";

interface Speller {
  check(word: string): boolean;
  suggest(word: string, limit?: number): string[];
}

const LANGS = [
  { name: "en", aff: "en.aff", dic: "en.dic" },
  { name: "pt", aff: "pt.aff", dic: "pt.dic" },
];

// Built lazily on first `check`: parsing both dictionaries (~7s, mostly pt-br)
// happens once, off the UI thread; every later message is a hash/affix lookup.
let spellers: Speller[] | null = null;
let building: Promise<Speller[]> | null = null;
// Accepted via "Add to dictionary" — kept here so they pass `correct` without
// re-parsing a dictionary, and survive a worker respawn (the client replays them).
const userWords = new Set<string>();

async function fetchText(base: string, file: string): Promise<string> {
  const res = await fetch(`${base}dict/${file}`);
  if (!res.ok) throw new Error(`spell: dict fetch ${file} → ${res.status}`);
  return res.text();
}

async function build(base: string): Promise<Speller[]> {
  const built = await Promise.all(
    LANGS.map(async (l) => {
      const [aff, dic] = await Promise.all([fetchText(base, l.aff), fetchText(base, l.dic)]);
      return new Typo(l.name, aff, dic) as unknown as Speller;
    }),
  );
  spellers = built;
  return built;
}

function ensure(base: string): Promise<Speller[]> {
  if (spellers) return Promise.resolve(spellers);
  if (!building) building = build(base);
  return building;
}

// camelCase / snake_case / kebab identifiers split into sub-words so code reads
// cleanly; tokens with digits and lone letters are skipped. Offsets are
// absolute into `text` for mapping back to Monaco positions.
const WORD = /[\p{L}][\p{L}\p{M}'’]*/gu;
const SUBWORD = /[\p{Lu}]?[\p{Ll}\p{M}]+|[\p{Lu}]+(?![\p{Ll}])|[\p{L}\p{M}]+/gu;

interface Token {
  word: string;
  start: number;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const whole = m[0];
    const base = m.index ?? 0;
    if (/\d/.test(whole)) continue;
    for (const sm of whole.matchAll(SUBWORD)) {
      const sub = sm[0];
      if (sub.length < 2) continue;
      out.push({ word: sub, start: base + (sm.index ?? 0) });
    }
  }
  return out;
}

// Correct if *any* active language accepts it — mixed-language repos are the norm.
function correct(sp: Speller[], word: string): boolean {
  if (userWords.has(word.toLowerCase())) return true;
  return sp.some((s) => s.check(word));
}

export interface Misspelling {
  word: string;
  start: number;
  end: number;
}

interface CheckMsg {
  type: "check";
  base: string;
  id: number;
  text: string;
}
interface SuggestMsg {
  type: "suggest";
  base: string;
  id: number;
  word: string;
}
interface AddMsg {
  type: "add";
  word: string;
}
type InMsg = CheckMsg | SuggestMsg | AddMsg;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "add") {
    userWords.add(msg.word.toLowerCase());
    return;
  }
  if (msg.type === "check") {
    const sp = await ensure(msg.base);
    const bad: Misspelling[] = [];
    for (const t of tokenize(msg.text)) {
      if (!correct(sp, t.word)) bad.push({ word: t.word, start: t.start, end: t.start + t.word.length });
    }
    ctx.postMessage({ type: "check", id: msg.id, misspellings: bad });
    return;
  }
  if (msg.type === "suggest") {
    const sp = await ensure(msg.base);
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const s of sp) {
      if (s.check(msg.word)) continue;
      for (const w of s.suggest(msg.word, 5)) {
        if (seen.has(w)) continue;
        seen.add(w);
        suggestions.push(w);
        if (suggestions.length >= 8) break;
      }
      if (suggestions.length >= 8) break;
    }
    ctx.postMessage({ type: "suggest", id: msg.id, suggestions });
  }
};

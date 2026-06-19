// Main-thread façade over the spell worker: lazy-spawns it on first use,
// correlates request/response by id, and owns the persisted user dictionary.
import type { Misspelling } from "./worker";

const DICT_KEY = "ff.spell.userDict";

function loadUserDict(): string[] {
  try {
    const raw = localStorage.getItem(DICT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

// Public base path so the worker's `fetch` resolves /dict/* under any Vite base
// (Tauri serves the bundle from a non-root origin in some setups).
function base(): string {
  return import.meta.env.BASE_URL || "/";
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (v: unknown) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ type: string; id: number; misspellings?: Misspelling[]; suggestions?: string[] }>) => {
    const { id } = e.data;
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(e.data);
  };
  // Replay accepted words into a freshly spawned worker.
  for (const w of loadUserDict()) worker.postMessage({ type: "add", word: w });
  return worker;
}

export function check(text: string): Promise<Misspelling[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, (v) => resolve((v as { misspellings: Misspelling[] }).misspellings));
    w.postMessage({ type: "check", id, base: base(), text });
  });
}

export function suggest(word: string): Promise<string[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, (v) => resolve((v as { suggestions: string[] }).suggestions));
    w.postMessage({ type: "suggest", id, base: base(), word });
  });
}

export function isUserWord(word: string): boolean {
  return loadUserDict().includes(word.toLowerCase());
}

export function addUserWord(word: string) {
  addUserWords([word]);
}

// Returns how many were newly added (case-insensitive, deduped).
export function addUserWords(words: string[]): number {
  const dict = loadUserDict();
  const have = new Set(dict);
  const w = ensureWorker();
  let added = 0;
  for (const raw of words) {
    const lower = raw.toLowerCase();
    if (have.has(lower)) continue;
    have.add(lower);
    dict.push(lower);
    w.postMessage({ type: "add", word: lower });
    added++;
  }
  if (added) localStorage.setItem(DICT_KEY, JSON.stringify(dict));
  return added;
}

// Fuzzy path matching for the quick-open palette (fzf-style subsequence
// scoring) plus the per-monitor recently-opened list that boosts ranking.

export interface FuzzyHit {
  score: number;
  /** Indices into the target that matched, for highlight rendering. */
  positions: number[];
}

const BONUS_BOUNDARY = 8;
const BONUS_SEPARATOR = 12; // right after "/" — start of a path segment
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 10;
const BONUS_FIRST_CHAR = 12;
const GAP_PENALTY = 1;
const MAX_GAP_PENALTY = 12;

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}
function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

function boundaryBonus(target: string, i: number): number {
  if (i === 0) return BONUS_FIRST_CHAR;
  const prev = target[i - 1];
  if (prev === "/") return BONUS_SEPARATOR;
  if (prev === "_" || prev === "-" || prev === "." || prev === " ") return BONUS_BOUNDARY;
  if (isLower(prev) && isUpper(target[i])) return BONUS_CAMEL;
  return 0;
}

/** Case-insensitive subsequence match with boundary/run-aware scoring.
 *  Returns null when `query` is not a subsequence of `target`. */
export function fuzzyMatch(query: string, target: string): FuzzyHit | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length > t.length) return null;

  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    // Prefer the next boundary occurrence of this char over the first plain
    // one, so "hv" lands on History**V**iew rather than a mid-word "v".
    let plain = -1;
    let chosen = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== q[qi]) continue;
      if (plain < 0) plain = j;
      if (j === lastMatch + 1 || boundaryBonus(target, j) > 0) {
        chosen = j;
        break;
      }
    }
    if (chosen < 0) chosen = plain;
    if (chosen < 0) return null;

    if (chosen === lastMatch + 1) score += BONUS_CONSECUTIVE;
    score += boundaryBonus(target, chosen);
    if (lastMatch >= 0) score -= Math.min(MAX_GAP_PENALTY, (chosen - lastMatch - 1) * GAP_PENALTY);
    if (target[chosen] === query[qi]) score += 1; // exact case
    positions.push(chosen);
    lastMatch = chosen;
    ti = chosen + 1;
  }
  // Shorter targets and matches near the end (basename) rank higher.
  score += Math.max(0, 16 - Math.floor((t.length - lastMatch) / 4));
  score -= Math.floor(t.length / 24);
  return { score, positions };
}

const MAX_RECENTS = 50;
const recentKey = (monitorId: number) => `ff.recent.${monitorId}`;

export function getRecents(monitorId: number): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(monitorId)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function recordRecent(monitorId: number, path: string) {
  const list = [path, ...getRecents(monitorId).filter((p) => p !== path)].slice(0, MAX_RECENTS);
  localStorage.setItem(recentKey(monitorId), JSON.stringify(list));
}

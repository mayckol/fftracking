// Breakpoint store: absolute file path → set of 1-based lines. Persisted to
// localStorage so breakpoints survive restarts; the debug session (lib/debug)
// subscribes and pushes changes to delve while a session is live.

const KEY = "ff.breakpoints";

const bps = new Map<string, Set<number>>(load());
const subs = new Set<(path: string) => void>();

function load(): [string, Set<number>][] {
  try {
    const raw: Record<string, number[]> = JSON.parse(localStorage.getItem(KEY) || "{}");
    return Object.entries(raw).map(([p, lines]) => [p, new Set(lines)]);
  } catch {
    return [];
  }
}

function persist() {
  const out: Record<string, number[]> = {};
  for (const [p, lines] of bps) if (lines.size) out[p] = [...lines];
  localStorage.setItem(KEY, JSON.stringify(out));
}

export function breakpointLines(path: string): Set<number> {
  return bps.get(path) ?? new Set();
}

export function allBreakpoints(): ReadonlyMap<string, Set<number>> {
  return bps;
}

export function toggleBreakpoint(path: string, line: number) {
  let lines = bps.get(path);
  if (!lines) {
    lines = new Set();
    bps.set(path, lines);
  }
  if (lines.has(line)) lines.delete(line);
  else lines.add(line);
  persist();
  subs.forEach((cb) => cb(path));
}

export function subscribeBreakpoints(cb: (path: string) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

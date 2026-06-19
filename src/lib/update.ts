import { getVersion } from "@tauri-apps/api/app";
import { api } from "./ipc";

const REPO = "mayckol/fftracking";

export interface UpdateState {
  current: string;
  latest: string;
  available: boolean;
  url: string;
}

// Numeric semver compare; ignores a leading "v" and any pre-release suffix.
function cmp(a: string, b: string): number {
  const parse = (s: string) =>
    s.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Resolves the latest GitHub release and compares it to the running version.
// Returns null for dev builds or when the check can't complete (offline, rate
// limited) — callers treat that as "no update to show".
export async function checkUpdate(): Promise<UpdateState | null> {
  const method = await api.installMethod().catch(() => "dev");
  if (method === "dev") return null;
  try {
    const current = await getVersion();
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = String(data.tag_name ?? "").replace(/^v/, "");
    if (!latest) return null;
    return {
      current,
      latest,
      available: cmp(latest, current) > 0,
      url: String(data.html_url ?? `https://github.com/${REPO}/releases/latest`),
    };
  } catch {
    return null;
  }
}

export const runUpdate = () => api.runUpdate();

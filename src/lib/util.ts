import { languageForPath } from "./plugins/registry";

export function basename(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function dayLabel(bucket: string): string {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  const y = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  if (bucket === iso) return "Today";
  if (bucket === y) return "Yesterday";
  return new Date(bucket + "T00:00:00").toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust", go: "go", py: "python", rb: "ruby", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", html: "html", css: "css", scss: "scss", sql: "sql",
  sh: "shell", bash: "shell", xml: "xml", php: "php", swift: "swift", lua: "lua",
};

export function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const builtin = LANG[ext];
  if (builtin) return builtin;
  // Unknown extension: an enabled plugin may claim it (e.g. dotenv for .env).
  return languageForPath(path) ?? "plaintext";
}

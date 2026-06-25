import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface MergeParams {
  repo: string;
  path: string;
  ours: string;
  theirs: string;
}

// Stable 32-bit hash → base36. Keyed on repo + path so two repos with the same
// relative path (or paths that collapse under a lossy slug / 80-char truncation)
// never share a window label.
const hash = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const labelFor = (repo: string, path: string) => "merge-" + hash(repo + "\0" + path);

// Labels whose creation is in flight, so a fast double-click coalesces instead of
// racing two `new WebviewWindow` calls on the same (unique) label.
const inFlight = new Set<string>();

// Open (or focus) a standalone OS window running the 3-pane merge editor for one
// file. Params ride the URL; main.tsx routes `view=merge` to the merge root.
export async function openMergeWindow(p: MergeParams, notify?: (msg: string, error?: boolean) => void): Promise<void> {
  const label = labelFor(p.repo, p.path);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  if (inFlight.has(label)) return;
  inFlight.add(label);
  const qs = new URLSearchParams({ view: "merge", repo: p.repo, path: p.path, ours: p.ours, theirs: p.theirs });
  const win = new WebviewWindow(label, {
    url: `index.html?${qs.toString()}`,
    title: `Merge — ${p.path}`,
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    focus: true,
    // Dark webview base so the window never paints white before the bundle loads.
    backgroundColor: [10, 12, 16, 255],
  });
  win.once("tauri://created", () => inFlight.delete(label));
  win.once("tauri://error", (e) => {
    inFlight.delete(label);
    console.error("merge window failed", e);
    notify?.(`Couldn't open the merge editor for ${p.path}`, true);
  });
}

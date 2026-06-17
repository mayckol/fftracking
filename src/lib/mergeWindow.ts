import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface MergeParams {
  repo: string;
  path: string;
  ours: string;
  theirs: string;
}

const labelFor = (path: string) => "merge-" + path.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

// Open (or focus) a standalone OS window running the 3-pane merge editor for one
// file. Params ride the URL; main.tsx routes `view=merge` to the merge root.
export async function openMergeWindow(p: MergeParams): Promise<void> {
  const label = labelFor(p.path);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
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
  win.once("tauri://error", (e) => console.error("merge window failed", e));
}

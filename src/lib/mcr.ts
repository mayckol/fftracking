import { api } from "./ipc";

type Toast = (msg: string, error?: boolean) => void;

// Merge and compare are delegated to the external MCR app; errors (chiefly the
// not-installed hint from the Rust side) surface as toasts.
export async function openMcrMerge(repo: string, path: string, toast: Toast): Promise<void> {
  try {
    await api.mcrOpenMerge(repo, path);
  } catch (e) {
    toast(String(e), true);
  }
}

// Whole-repo compare in a standalone MCR window — used by the History panel,
// which wants MCR's own file sidebar across the entire repo against a ref. The
// Git tab uses the embedded per-file diff below instead.
export async function openMcrDiff(repo: string, ref: string, toast: Toast): Promise<void> {
  try {
    await api.mcrOpenDiff(repo, ref);
  } catch (e) {
    toast(String(e), true);
  }
}

export interface McrBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Compare/diff is embedded as a child webview over the Git pane (Rust side:
// mcr_embed.rs). Show carries the file to render + where to sit; set-bounds/hide
// track the pane. Only Show surfaces errors (a failed launch is worth a toast);
// reposition/hide stay silent so a rapid resize never spams the user.
export async function mcrEmbedShow(
  repoRoot: string,
  refspec: string,
  path: string,
  bounds: McrBounds,
  toast: Toast,
): Promise<void> {
  try {
    await api.mcrEmbedShow(repoRoot, refspec, path, bounds);
  } catch (e) {
    toast(String(e), true);
  }
}

export async function mcrEmbedSetBounds(bounds: McrBounds): Promise<void> {
  try {
    await api.mcrEmbedSetBounds(bounds);
  } catch {
    // transient during teardown/resize — the next push corrects it
  }
}

export async function mcrEmbedHide(): Promise<void> {
  try {
    await api.mcrEmbedHide();
  } catch {
    // already hidden or not yet created
  }
}

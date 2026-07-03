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

export async function openMcrDiff(repo: string, ref: string, toast: Toast): Promise<void> {
  try {
    await api.mcrOpenDiff(repo, ref);
  } catch (e) {
    toast(String(e), true);
  }
}

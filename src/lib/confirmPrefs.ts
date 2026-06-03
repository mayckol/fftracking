// Remembers which confirmation dialogs the user chose to suppress
// ("Don't show this again"), persisted locally.

const KEY = "ff.suppressedConfirms";

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export function isConfirmSuppressed(id: string): boolean {
  return !!load()[id];
}

export function suppressConfirm(id: string) {
  const m = load();
  m[id] = true;
  localStorage.setItem(KEY, JSON.stringify(m));
}

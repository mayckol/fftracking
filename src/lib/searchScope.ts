// Last folder the user clicked in the project tree — ⌘⇧F / ⌘⇧R scope their
// search to it. Selecting a file clears it (intent moved to the file).

let scopeDir: string | null = null;

export function setScopeDir(dir: string | null) {
  scopeDir = dir;
}

export function getScopeDir(): string | null {
  return scopeDir;
}

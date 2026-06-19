// Plugin registry: install/enable state (localStorage + pub/sub, mirroring
// uiPrefs), the live Monaco wiring, and the path→language lookup that langOf
// consults. Bundled-only today; the catalog is the single seam a marketplace
// would extend.

import { useEffect, useReducer } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MEditor } from "monaco-editor";
import { CATALOG, findPlugin } from "./catalog";
import type { FFPlugin } from "./types";

export type { FFPlugin, PluginManifest } from "./types";
export { CATALOG } from "./catalog";

interface PluginState {
  installed: string[];
  enabled: Record<string, boolean>;
}

const KEY = "ff.plugins";
const subs = new Set<() => void>();

function seed(): PluginState {
  const installed = CATALOG.filter((p) => p.manifest.defaultInstalled).map((p) => p.manifest.id);
  const enabled: Record<string, boolean> = {};
  for (const id of installed) enabled[id] = true;
  return { installed, enabled };
}

function load(): PluginState {
  const raw = localStorage.getItem(KEY);
  if (raw == null) return seed();
  try {
    const p = JSON.parse(raw) as Partial<PluginState>;
    const st: PluginState = { installed: p.installed ?? [], enabled: p.enabled ?? {} };
    // Auto-install bundled defaults missing from saved state, so new built-in
    // plugins (e.g. go.mod highlight) light up on upgrade rather than only on
    // a fresh install.
    for (const pl of CATALOG) {
      const id = pl.manifest.id;
      if (pl.manifest.defaultInstalled && !st.installed.includes(id)) {
        st.installed.push(id);
        if (st.enabled[id] === undefined) st.enabled[id] = true;
      }
    }
    return st;
  } catch {
    return seed();
  }
}

let state = load();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
  subs.forEach((fn) => fn());
}

export function isInstalled(id: string): boolean {
  return state.installed.includes(id);
}

// Installed *and* switched on — the only state in which a plugin contributes.
export function isEnabled(id: string): boolean {
  return isInstalled(id) && state.enabled[id] !== false;
}

export function install(id: string) {
  if (!findPlugin(id) || isInstalled(id)) return;
  state = {
    installed: [...state.installed, id],
    enabled: { ...state.enabled, [id]: state.enabled[id] ?? true },
  };
  persist();
}

export function uninstall(id: string) {
  if (!isInstalled(id)) return;
  state = { installed: state.installed.filter((x) => x !== id), enabled: { ...state.enabled } };
  persist();
}

export function setEnabled(id: string, on: boolean) {
  if (!isInstalled(id)) return;
  state = { ...state, enabled: { ...state.enabled, [id]: on } };
  persist();
}

export function activePlugins(): FFPlugin[] {
  return CATALOG.filter((p) => isEnabled(p.manifest.id));
}

// The Monaco language id an active plugin claims for this path, or null.
export function languageForPath(path: string): string | null {
  for (const p of activePlugins()) {
    if (p.language?.matches(path)) return p.language.idForPath?.(path) ?? p.language.id;
  }
  return null;
}

export function subscribePlugins(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

// Re-renders the caller whenever plugin state changes, so langOf-derived
// `language` props recompute and open editors switch tokenizer live.
export function usePlugins(): number {
  const [v, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribePlugins(bump), []);
  return v;
}

// --- Monaco wiring -------------------------------------------------------

let monacoRef: Monaco | null = null;
const registeredLangs = new Set<string>();

function applyActive() {
  if (!monacoRef) return;
  for (const p of activePlugins()) {
    const lang = p.language;
    // Monaco can't cleanly unregister a language, so registration is one-way:
    // disabling a plugin stops langOf routing files to it (they fall back to
    // plaintext) rather than tearing the grammar down.
    if (lang && !registeredLangs.has(lang.id)) {
      lang.register(monacoRef);
      registeredLangs.add(lang.id);
    }
  }
}

// Called from each editor's beforeMount. Idempotent across editor instances.
export function initPluginsForMonaco(monaco: Monaco) {
  monacoRef = monaco;
  applyActive();
}

// A plugin enabled at runtime must register its grammar now, after mount.
subscribePlugins(applyActive);

// --- Per-editor wiring ---------------------------------------------------

// Wires every active `editor`-capability plugin into a mounted editor, and
// keeps that set in sync as plugins toggle: enabling attaches live, disabling
// runs the plugin's disposer (e.g. clears its markers). Call once from onMount.
export function attachPluginsToEditor(monaco: Monaco, editor: MEditor.ICodeEditor): void {
  const attached = new Map<string, () => void>();

  const sync = () => {
    for (const p of CATALOG) {
      if (!p.editor) continue;
      const id = p.manifest.id;
      const on = isEnabled(id);
      if (on && !attached.has(id)) attached.set(id, p.editor.attach(monaco, editor));
      else if (!on && attached.has(id)) {
        attached.get(id)!();
        attached.delete(id);
      }
    }
  };

  sync();
  const unsub = subscribePlugins(sync);
  editor.onDidDispose(() => {
    unsub();
    attached.forEach((dispose) => dispose());
    attached.clear();
  });
}

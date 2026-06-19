import type { Monaco } from "@monaco-editor/react";

// Where a plugin came from. Only "bundled" ships today; "marketplace" is the
// seam for fetching plugins from a remote catalog later — the registry, UI and
// state model already treat plugins generically so that drop-in needs no
// rework here.
export type PluginSource = "bundled" | "marketplace";

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: PluginSource;
  // Installed (and enabled) on first run, before the user touches anything.
  defaultInstalled?: boolean;
}

// A plugin's editor-language contribution: which files it claims and how it
// teaches Monaco to tokenize them.
export interface PluginLanguage {
  // Monaco language id this plugin defines (e.g. "dotenv").
  id: string;
  // Whether this plugin's language should drive the given file path.
  matches(path: string): boolean;
  // When a plugin defines several ids (e.g. .tsx→typescriptreact, .jsx→
  // javascriptreact), the per-path id; defaults to `id`.
  idForPath?(path: string): string | null;
  // Register the language + grammar with a Monaco instance. Called at most once
  // per instance (the registry guards against duplicate registration).
  register(monaco: Monaco): void;
}

// A plugin's per-editor contribution: wired once for each mounted editor.
// `attach` runs on mount and returns a disposer the registry calls when the
// editor goes away or the plugin is disabled at runtime.
export interface PluginEditor {
  attach(monaco: Monaco, editor: import("monaco-editor").editor.ICodeEditor): () => void;
}

export interface FFPlugin {
  manifest: PluginManifest;
  // Optional capabilities. More contribution points (commands, themes, …) slot
  // in alongside this one without changing the registry contract.
  language?: PluginLanguage;
  editor?: PluginEditor;
}

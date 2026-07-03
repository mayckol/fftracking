// Must run before monaco-editor is imported (Monaco reads navigator.userAgent at
// module-eval to pick its OS, and WebKitGTK on Linux lies that it is a Mac).
import "./lib/fixPlatform";
import { installLogForwarding } from "./lib/log";
import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

import "@fontsource/archivo/400.css";
import "@fontsource/archivo/500.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/jetbrains-mono/300.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";

import "./styles.css";
import { applyTheme, getTheme } from "./lib/themes";
import { applyUIVars, getPrefs, subscribePrefs } from "./lib/uiPrefs";
import { defineAllThemes } from "./components/monacoTheme";

// Tee the webview console + uncaught errors to the app log (stdout + file) so
// they can be followed from a terminal, not just devtools.
installLogForwarding();

// Theme CSS variables must land before first paint; Monaco picks its theme up
// via the `theme` prop on the editors.
applyTheme(getTheme(getPrefs().theme));
applyUIVars(getPrefs());
subscribePrefs(() => {
  applyTheme(getTheme(getPrefs().theme));
  applyUIVars(getPrefs());
});

// Bundle Monaco locally (no CDN) so the app works fully offline.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

// vtsls (a real, project-aware language server) owns TS/JS — so silence
// Monaco's bundled in-browser TypeScript service, which otherwise registers its
// own providers + a project-blind diagnostics worker on the same "typescript"/
// "javascript" ids and stacks duplicate completions and bogus markers ("Cannot
// find module …") under the real ones. Run at module-eval, before any TS/JS
// model exists, so the built-in mode is configured off from the start. Monarch
// colorization is a separate path and stays on. See src/lib/lsp.ts (vtsls).
{
  const noDiag = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true };
  const noFeatures = {
    completionItems: false, hovers: false, documentSymbols: false, definitions: false,
    references: false, signatureHelp: false, codeActions: false, rename: false,
    documentHighlights: false, onTypeFormattingEdits: false, diagnostics: false,
    inlayHints: false, documentRangeFormattingEdits: false,
  };
  for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    d.setDiagnosticsOptions(noDiag);
    d.setModeConfiguration(noFeatures);
  }
}
// Define editor themes at startup, not just in editor beforeMount — already
// mounted editors otherwise keep stale theme data across HMR/theme edits.
defineAllThemes(monaco);

const root = ReactDOM.createRoot(document.getElementById("root")!);
const dropBoot = () => requestAnimationFrame(() => document.getElementById("ff-boot")?.remove());

import("./App").then(({ default: Root }) => {
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
  dropBoot();
});

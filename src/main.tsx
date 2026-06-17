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
// Define editor themes at startup, not just in editor beforeMount — already
// mounted editors otherwise keep stale theme data across HMR/theme edits.
defineAllThemes(monaco);

// A `view=merge` window renders only the standalone merge editor. Load App vs
// MergeWindow lazily so the merge window doesn't pull the whole app's panels —
// it gets its own small chunk (Monaco stays shared in the entry).
const isMergeWindow = new URLSearchParams(window.location.search).get("view") === "merge";
const root = ReactDOM.createRoot(document.getElementById("root")!);
const dropBoot = () => requestAnimationFrame(() => document.getElementById("ff-boot")?.remove());

(isMergeWindow ? import("./panels/MergeWindow") : import("./App")).then(({ default: Root }) => {
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
  dropBoot();
});

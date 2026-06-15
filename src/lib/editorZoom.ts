// Editor font zoom: a thin wrapper over Monaco's global EditorZoom singleton.
// Zoom is process-wide (every open editor scales together) and applies a
// font multiplier of 1 + level*0.1, clamped to [-5, 20] → 50%…300%. Level 0
// is 100% (the base fontSize from UI prefs).

import { useEffect, useState } from "react";

// Deep import so we read/write the same singleton Monaco's editors observe.
// Typed via src/types/monaco-internal.d.ts (the package ships no .d.ts here).
import { EditorZoom } from "monaco-editor/esm/vs/editor/common/config/editorZoom.js";

export function zoomIn() {
  EditorZoom.setZoomLevel(EditorZoom.getZoomLevel() + 1);
}

export function zoomOut() {
  EditorZoom.setZoomLevel(EditorZoom.getZoomLevel() - 1);
}

export function resetZoom() {
  EditorZoom.setZoomLevel(0);
}

export function zoomPercent(level = EditorZoom.getZoomLevel()): number {
  return Math.round((1 + level * 0.1) * 100);
}

/** Current zoom level, re-rendering on every change. */
export function useZoomLevel(): number {
  const [level, setLevel] = useState(EditorZoom.getZoomLevel());
  useEffect(() => {
    const sub = EditorZoom.onDidChangeZoomLevel(setLevel);
    return () => sub.dispose();
  }, []);
  return level;
}

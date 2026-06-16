// Snapshot of the focused editor, published by FileView and rendered in the
// app-wide bottom status bar (language, cursor, diagnostics, LSP). Cleared when
// no file editor is mounted.

import { useEffect, useState } from "react";

export type LspPhase = "off" | "starting" | "ready" | "error";

export interface EditorStatus {
  language: string;
  line: number;
  col: number;
  errors: number;
  warnings: number;
  lsp: LspPhase;
  root: string | null;
}

let cur: EditorStatus | null = null;
const subs = new Set<() => void>();

export function setEditorStatus(s: EditorStatus | null) {
  cur = s;
  subs.forEach((fn) => fn());
}

export function getEditorStatus(): EditorStatus | null {
  return cur;
}

export function useEditorStatus(): EditorStatus | null {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  return cur;
}

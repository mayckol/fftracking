import { useEffect, useState } from "react";

export type MdViewMode = "raw" | "both" | "read";

// Session-scoped (in-memory) — survives file switches but not app restart,
// mirroring how editorZoom keeps process-wide state without persisting.
let mode: MdViewMode = "raw";
const listeners = new Set<(m: MdViewMode) => void>();

export function getMdViewMode(): MdViewMode {
  return mode;
}

export function setMdViewMode(next: MdViewMode): void {
  if (next === mode) return;
  mode = next;
  for (const fn of listeners) fn(mode);
}

export function useMdViewMode(): [MdViewMode, (m: MdViewMode) => void] {
  const [m, setM] = useState(mode);
  useEffect(() => {
    listeners.add(setM);
    return () => {
      listeners.delete(setM);
    };
  }, []);
  return [m, setMdViewMode];
}

// Editor/preview width ratio in Both mode (editor fraction), clamped 0.2–0.8.
let split = 0.5;
const splitListeners = new Set<(n: number) => void>();

export function getMdSplit(): number {
  return split;
}

export function setMdSplit(next: number): void {
  const clamped = Math.min(0.8, Math.max(0.2, next));
  if (clamped === split) return;
  split = clamped;
  for (const fn of splitListeners) fn(split);
}

export function useMdSplit(): [number, (n: number) => void] {
  const [s, setS] = useState(split);
  useEffect(() => {
    splitListeners.add(setS);
    return () => {
      splitListeners.delete(setS);
    };
  }, []);
  return [s, setMdSplit];
}

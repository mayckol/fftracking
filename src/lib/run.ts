// Runs tests / programs without the integrated terminal: the Rust side spawns
// the process and streams its output over `run://*` events, which this module
// collects into a small state machine the Run panel renders. One run at a time
// — starting a new one stops the previous. Mirrors lib/debug's plumbing style.

import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import type { AnsiSpan } from "./ansi";
import { recordRun } from "./execHistory";

export type RunStatus = "idle" | "running" | "exited";

export interface RunLine {
  kind: "out" | "err" | "info";
  text: string;
  /** Lazily-parsed ANSI spans, cached by the panel on first render. */
  spans?: AnsiSpan[];
}

export interface RunSpec {
  cwd: string;
  /** Human-readable command label shown in the panel header. */
  label: string;
  program: string;
  args: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
}

interface RunSnapshot {
  status: RunStatus;
  title: string;
  /** Process exit code once finished; null while running or if unknown. */
  exitCode: number | null;
}

const state: RunSnapshot = { status: "idle", title: "", exitCode: null };
let lines: RunLine[] = [];
let sessionId: number | null = null;
let listening = false;

const subs = new Set<() => void>();
let opener: (() => void) | null = null;

/** App registers here so starting a run reveals the run panel. */
export function setRunOpener(fn: (() => void) | null) {
  opener = fn;
}

export function subscribeRun(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getRunSnapshot(): Readonly<RunSnapshot> {
  return state;
}

export function getRunLines(): RunLine[] {
  return lines;
}

export function clearRun() {
  lines = [];
  emit();
}

function emit() {
  subs.forEach((cb) => cb());
}

function log(kind: RunLine["kind"], text: string) {
  lines.push({ kind, text });
  if (lines.length > 5000) lines = lines.slice(-3000);
  emit();
}

async function ensureListener() {
  if (listening) return;
  listening = true;
  await listen<{ id: number; kind: string; text: string }>("run://output", (e) => {
    if (e.payload.id !== sessionId) return;
    log(e.payload.kind === "err" ? "err" : "out", e.payload.text);
  });
  await listen<{ id: number; code: number | null }>("run://exit", (e) => {
    if (e.payload.id !== sessionId) return;
    sessionId = null;
    state.status = "exited";
    state.exitCode = e.payload.code;
    const code = e.payload.code;
    log("info", code == null ? "\nProcess finished.\n" : `\nProcess finished with exit code ${code}.\n`);
    emit();
  });
}

export async function startRun(spec: RunSpec) {
  await stopRun();
  recordRun(spec);
  lines = [];
  state.status = "running";
  state.title = spec.label;
  state.exitCode = null;
  opener?.();
  emit();
  try {
    await ensureListener();
    log("info", `${spec.label}\n\n`);
    sessionId = await api.runStart(spec.cwd, spec.program, spec.args, spec.env);
  } catch (e) {
    log("err", `${e}\n`);
    state.status = "exited";
    state.exitCode = null;
    emit();
  }
}

export async function stopRun() {
  const id = sessionId;
  sessionId = null;
  if (id == null) return;
  try {
    await api.runStop(id);
  } catch {
    // Already gone — the panel reflects the exited state regardless.
  }
  if (state.status === "running") {
    state.status = "exited";
    log("info", "\nStopped.\n");
    emit();
  }
}

// DAP client for Go debugging via delve (one session at a time, spawned by the
// Rust side over `dap://*` events). Owns the session state machine the debug
// panel and editors render: launch → breakpoints → stopped/stack/variables →
// step/resume → exit. Mirrors the JSON-RPC plumbing style of lib/lsp.ts.

import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { allBreakpoints, breakpointLines, subscribeBreakpoints } from "./breakpoints";
import { openLocation } from "./lsp";

type Json = any;

export type DebugStatus = "idle" | "starting" | "running" | "paused" | "exited";

export interface StackFrame {
  id: number;
  name: string;
  /** Absolute source path; null for frames without source (runtime, asm). */
  path: string | null;
  line: number;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  /** > 0 → expandable via dbgVariables(). */
  variablesReference: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
}

export interface ConsoleLine {
  kind: "out" | "err" | "in" | "info";
  text: string;
}

export interface LaunchConfig {
  root: string;
  /** Human-readable config name, e.g. "go test -run ^TestFoo$ ./pkg". */
  name: string;
  mode: "debug" | "test";
  /** Absolute package dir (or main package dir) delve builds and runs. */
  program: string;
  args?: string[];
}

export interface DebugSnapshot {
  status: DebugStatus;
  title: string;
  stopReason: string;
  /** Launch / adapter failure message, shown in the panel. */
  error: string;
  frames: StackFrame[];
  currentFrame: StackFrame | null;
  /** Flat locals+arguments of the current frame, for inline editor values. */
  frameVars: DapVariable[];
  threadId: number | null;
}

const state: DebugSnapshot = {
  status: "idle",
  title: "",
  stopReason: "",
  error: "",
  frames: [],
  currentFrame: null,
  frameVars: [],
  threadId: null,
};

let sessionId: number | null = null;
let sessionRoot = "";
let seq = 0;
const pending = new Map<number, (msg: Json) => void>();
let listening = false;
let consoleLines: ConsoleLine[] = [];

const subs = new Set<() => void>();
let opener: (() => void) | null = null;

/** App registers here so starting a session reveals the debug panel. */
export function setDebugOpener(fn: (() => void) | null) {
  opener = fn;
}

export function subscribeDebug(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getDebugSnapshot(): Readonly<DebugSnapshot> {
  return state;
}

export function getConsoleLines(): ConsoleLine[] {
  return consoleLines;
}

export function clearConsole() {
  consoleLines = [];
  emit();
}

function emit() {
  subs.forEach((cb) => cb());
}

function logLine(kind: ConsoleLine["kind"], text: string) {
  consoleLines.push({ kind, text });
  if (consoleLines.length > 3000) consoleLines = consoleLines.slice(-2000);
  emit();
}

function send(command: string, args: Json): Promise<Json> {
  if (sessionId == null) return Promise.reject("no debug session");
  const id = sessionId;
  const s = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(s, (msg) =>
      msg.success ? resolve(msg.body ?? {}) : reject(msg.message ?? `${command} failed`),
    );
    api.dapSend(id, JSON.stringify({ seq: s, type: "request", command, arguments: args })).catch((e) => {
      pending.delete(s);
      reject(e);
    });
  });
}

async function ensureListener() {
  if (listening) return;
  listening = true;
  await listen<{ id: number; body: string }>("dap://message", (e) => {
    if (e.payload.id !== sessionId) return;
    let msg: Json;
    try {
      msg = JSON.parse(e.payload.body);
    } catch {
      return;
    }
    if (msg.type === "response") {
      const p = pending.get(msg.request_seq);
      if (p) {
        pending.delete(msg.request_seq);
        p(msg);
      }
      return;
    }
    if (msg.type === "event") handleEvent(msg.event, msg.body ?? {});
  });
  await listen<number>("dap://exit", (e) => {
    if (e.payload === sessionId) endSession();
  });
}

function handleEvent(event: string, body: Json) {
  switch (event) {
    case "initialized":
      // Adapter is ready for configuration: install all persisted breakpoints
      // for this workspace, then let the program run.
      pushAllBreakpoints()
        .then(() => send("configurationDone", {}))
        .catch(() => {});
      break;
    case "stopped":
      onStopped(body);
      break;
    case "continued":
      state.status = "running";
      clearPausedState();
      emit();
      break;
    case "output":
      logLine(body.category === "stderr" ? "err" : "out", body.output ?? "");
      break;
    case "terminated":
    case "exited":
      stopDebug();
      break;
  }
}

async function onStopped(body: Json) {
  state.status = "paused";
  state.stopReason = body.reason ?? "";
  state.threadId = body.threadId ?? state.threadId ?? 1;
  emit();
  try {
    const st = await send("stackTrace", { threadId: state.threadId, startFrame: 0, levels: 50 });
    state.frames = (st.stackFrames ?? []).map((f: Json) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? null,
      line: f.line ?? 0,
    }));
    selectFrame(state.frames.find((f: StackFrame) => f.path) ?? state.frames[0] ?? null);
  } catch {
    emit();
  }
}

/** Make `f` the frame the variables panel and editors look at, and jump the
 *  editor there (same open-file path ⌘-click definition uses). */
export function selectFrame(f: StackFrame | null) {
  state.currentFrame = f;
  emit();
  void loadFrameVars(f);
  if (f?.path && f.line > 0) openLocation(f.path, f.line, 1);
}

let varsToken = 0;
async function loadFrameVars(f: StackFrame | null) {
  const tok = ++varsToken;
  if (!f) {
    state.frameVars = [];
    emit();
    return;
  }
  try {
    const scopes = await dbgScopes(f.id);
    const out: DapVariable[] = [];
    for (const sc of scopes) out.push(...(await dbgVariables(sc.variablesReference)));
    if (tok !== varsToken) return;
    state.frameVars = out;
  } catch {
    if (tok !== varsToken) return;
    state.frameVars = [];
  }
  emit();
}

async function pushBreakpoints(path: string) {
  const lines = [...breakpointLines(path)].sort((a, b) => a - b);
  await send("setBreakpoints", {
    source: { name: path.split("/").pop(), path },
    breakpoints: lines.map((line) => ({ line })),
  });
}

async function pushAllBreakpoints() {
  for (const [path, lines] of allBreakpoints()) {
    if (!lines.size || !path.startsWith(`${sessionRoot}/`)) continue;
    await pushBreakpoints(path).catch(() => {});
  }
}

// Toggling a breakpoint mid-session syncs it into delve immediately.
subscribeBreakpoints((path) => {
  if (sessionId != null && state.status !== "exited") pushBreakpoints(path).catch(() => {});
});

export async function startDebug(cfg: LaunchConfig) {
  if (sessionId != null) await stopDebug();
  consoleLines = [];
  state.status = "starting";
  state.title = cfg.name;
  state.stopReason = "";
  state.error = "";
  clearPausedState();
  state.threadId = null;
  opener?.();
  emit();
  try {
    await ensureListener();
    sessionRoot = cfg.root;
    seq = 0;
    pending.clear();
    sessionId = await api.dapStart(cfg.root);
    await send("initialize", {
      clientID: "fftracking",
      adapterID: "go",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      locale: "en-US",
    });
    logLine("info", `${cfg.name}\n`);
    // The launch response only arrives after configurationDone (sent from the
    // `initialized` event handler), so it is not awaited inline.
    send("launch", {
      request: "launch",
      mode: cfg.mode,
      program: cfg.program,
      args: cfg.args ?? [],
      cwd: cfg.root,
    })
      .then(() => {
        if (state.status === "starting") {
          state.status = "running";
          emit();
        }
      })
      .catch((e) => {
        state.error = String(e);
        logLine("err", `${e}\n`);
        stopDebug();
      });
  } catch (e) {
    state.error = String(e);
    logLine("err", `${e}\n`);
    endSession();
  }
}

export async function stopDebug() {
  if (sessionId != null) {
    try {
      await send("disconnect", { terminateDebuggee: true });
    } catch {
      // Already gone — endSession cleans up regardless.
    }
  }
  endSession();
}

// Tears the session down and always lands the UI in "exited" — including
// launches that failed before a session id existed (e.g. dlv not installed).
function endSession() {
  const id = sessionId;
  sessionId = null;
  if (id != null) api.dapStop(id).catch(() => {});
  pending.forEach((p) => p({ success: false, message: "session ended" }));
  pending.clear();
  if (state.status === "idle") return;
  state.status = "exited";
  clearPausedState();
  state.threadId = null;
  if (id != null) logLine("info", "Debug session finished.\n");
  emit();
}

const tid = () => state.threadId ?? 1;

function clearPausedState() {
  state.frames = [];
  state.currentFrame = null;
  state.frameVars = [];
  varsToken++;
}

function step(command: "next" | "stepIn" | "stepOut") {
  if (state.status !== "paused") return;
  state.status = "running";
  clearPausedState();
  emit();
  send(command, { threadId: tid() }).catch(() => {});
}

export function dbgStepOver() {
  step("next");
}
export function dbgStepInto() {
  step("stepIn");
}
export function dbgStepOut() {
  step("stepOut");
}

export function dbgResume() {
  if (state.status !== "paused") return;
  state.status = "running";
  clearPausedState();
  emit();
  send("continue", { threadId: tid() }).catch(() => {});
}

export function dbgPause() {
  if (state.status !== "running") return;
  send("pause", { threadId: tid() }).catch(() => {});
}

export async function dbgScopes(frameId: number): Promise<DapScope[]> {
  const b = await send("scopes", { frameId });
  return b.scopes ?? [];
}

export async function dbgVariables(ref: number): Promise<DapVariable[]> {
  const b = await send("variables", { variablesReference: ref });
  return b.variables ?? [];
}

export async function dbgEvaluate(
  expression: string,
  context: "watch" | "repl" | "hover",
): Promise<{ result: string; variablesReference: number }> {
  const b = await send("evaluate", {
    expression,
    frameId: state.currentFrame?.id,
    context,
  });
  return { result: b.result ?? "", variablesReference: b.variablesReference ?? 0 };
}

/** Dotted expression around the cursor: hovering `input` in `tt.input` yields
 *  the full chain so delve evaluates the actual selector. */
function expressionAt(model: Json, position: Json): string | null {
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const line: string = model.getLineContent(position.lineNumber);
  let start = word.startColumn - 1;
  while (start > 0 && line[start - 1] === ".") {
    let i = start - 1;
    while (i > 0 && /[A-Za-z0-9_]/.test(line[i - 1])) i--;
    if (i === start - 1) break;
    start = i;
  }
  return line.slice(start, word.endColumn - 1);
}

let hoverRegistered = false;

/** While paused, hovering an identifier shows its live value (delve evaluate)
 *  alongside the gopls type hover — JetBrains-style. */
export function registerDebugHover(monaco: Json) {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("go", {
    async provideHover(model: Json, position: Json) {
      const f = state.currentFrame;
      if (state.status !== "paused" || !f || model.uri.scheme === "output") return null;
      const expr = expressionAt(model, position);
      if (!expr) return null;
      try {
        const r = await dbgEvaluate(expr, "hover");
        if (!r.result) return null;
        const val = r.result.length > 400 ? `${r.result.slice(0, 400)}…` : r.result;
        return { contents: [{ value: `**${expr}**\n\`\`\`go\n${val}\n\`\`\`` }] };
      } catch {
        return null;
      }
    },
  });
}

export function consoleEval(expression: string) {
  logLine("in", `> ${expression}\n`);
  dbgEvaluate(expression, "repl")
    .then((r) => logLine("out", `${r.result}\n`))
    .catch((e) => logLine("err", `${e}\n`));
}

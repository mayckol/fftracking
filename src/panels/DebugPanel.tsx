// JetBrains-style debug tool window: step controls in the header, then frames
// (call stack) + variables + watches on the Debugger tab and a REPL-capable
// log on the Console tab. All session data comes from lib/debug subscriptions.

import { useEffect, useRef, useState } from "react";
import Splitter from "../components/Splitter";
import { comboFor, formatCombo } from "../lib/shortcuts";
import {
  clearConsole,
  consoleEval,
  dbgEvaluate,
  dbgPause,
  dbgResume,
  dbgScopes,
  dbgStepInto,
  dbgStepOut,
  dbgStepOver,
  dbgVariables,
  getConsoleLines,
  getDebugSnapshot,
  selectFrame,
  stopDebug,
  subscribeDebug,
  type DapVariable,
  type DapScope,
  type StackFrame,
} from "../lib/debug";

interface Props {
  root: string | null;
  height: number;
  onResize: (delta: number) => void;
  onClose: () => void;
}

const WATCH_KEY = "ff.watches";

function loadWatches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
  } catch {
    return [];
  }
}

function VarRow({ v, depth }: { v: DapVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<DapVariable[] | null>(null);
  const expandable = v.variablesReference > 0;

  const toggle = async () => {
    if (!expandable) return;
    if (!open && kids == null) setKids(await dbgVariables(v.variablesReference).catch(() => []));
    setOpen((o) => !o);
  };

  return (
    <>
      <div
        className={`dbg-var${expandable ? " expandable" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={toggle}
      >
        <span className="dbg-caret">{expandable ? (open ? "▾" : "▸") : ""}</span>
        <span className="dbg-name">{v.name}</span>
        {v.type && <span className="dbg-type">{v.type}</span>}
        <span className="dbg-val" title={v.value}>
          {v.value}
        </span>
      </div>
      {open && kids?.map((k, i) => <VarRow key={`${k.name}:${i}`} v={k} depth={depth + 1} />)}
    </>
  );
}

/** Locals/arguments for the selected frame, refetched on every stop. */
function Variables({ frame }: { frame: StackFrame | null }) {
  const [scopes, setScopes] = useState<{ scope: DapScope; vars: DapVariable[] }[]>([]);

  useEffect(() => {
    let alive = true;
    if (!frame) {
      setScopes([]);
      return;
    }
    (async () => {
      const sc = await dbgScopes(frame.id).catch(() => []);
      const out = [];
      for (const scope of sc) {
        const vars = await dbgVariables(scope.variablesReference).catch(() => []);
        out.push({ scope, vars });
      }
      if (alive) setScopes(out);
    })();
    return () => {
      alive = false;
    };
  }, [frame]);

  if (!frame) return <div className="dbg-hint">Not paused — variables appear on a breakpoint.</div>;
  return (
    <div className="dbg-scroll">
      {scopes.map(({ scope, vars }) => (
        <div key={scope.name}>
          <div className="dbg-scope">{scope.name}</div>
          {vars.map((v, i) => (
            <VarRow key={`${frame.id}:${v.name}:${i}`} v={v} depth={0} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Watches({ frame, paused }: { frame: StackFrame | null; paused: boolean }) {
  const [watches, setWatches] = useState<string[]>(loadWatches);
  const [vals, setVals] = useState<Record<string, DapVariable>>({});
  const [input, setInput] = useState("");

  const save = (next: string[]) => {
    setWatches(next);
    localStorage.setItem(WATCH_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    let alive = true;
    if (!paused || !frame) {
      setVals({});
      return;
    }
    (async () => {
      const out: Record<string, DapVariable> = {};
      for (const w of watches) {
        try {
          const r = await dbgEvaluate(w, "watch");
          out[w] = { name: w, value: r.result, variablesReference: r.variablesReference };
        } catch (e) {
          out[w] = { name: w, value: `⚠ ${e}`, variablesReference: 0 };
        }
      }
      if (alive) setVals(out);
    })();
    return () => {
      alive = false;
    };
  }, [watches, frame, paused]);

  return (
    <div className="dbg-watches">
      <div className="dbg-scroll">
        {watches.map((w) => (
          <div key={w} className="dbg-watch-row">
            <div className="dbg-watch-var">
              {vals[w] ? (
                <VarRow v={vals[w]} depth={0} />
              ) : (
                <div className="dbg-var" style={{ paddingLeft: 8 }}>
                  <span className="dbg-caret" />
                  <span className="dbg-name">{w}</span>
                  <span className="dbg-val">—</span>
                </div>
              )}
            </div>
            <button className="term-tab-x" title="Remove watch" onClick={() => save(watches.filter((x) => x !== w))}>
              ×
            </button>
          </div>
        ))}
      </div>
      <input
        className="dbg-watch-input"
        placeholder="+ Add watch expression"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            if (!watches.includes(input.trim())) save([...watches, input.trim()]);
            setInput("");
          }
        }}
      />
    </div>
  );
}

function Console() {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = getConsoleLines();

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="dbg-console">
      <div className="dbg-scroll dbg-log" ref={scrollRef}>
        {lines.map((l, i) => (
          <span key={i} className={`dbg-line ${l.kind}`}>
            {l.text}
          </span>
        ))}
      </div>
      <input
        className="dbg-watch-input"
        placeholder="Evaluate expression (paused only)…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            consoleEval(input.trim());
            setInput("");
          }
        }}
      />
    </div>
  );
}

export default function DebugPanel({ root, height, onResize, onClose }: Props) {
  const [, force] = useState(0);
  const [view, setView] = useState<"debugger" | "console">("debugger");
  useEffect(() => subscribeDebug(() => force((n) => n + 1)), []);

  const s = getDebugSnapshot();
  const paused = s.status === "paused";
  const active = s.status === "starting" || s.status === "running" || paused;

  const frameLabel = (f: StackFrame) => {
    const loc =
      f.path && root && f.path.startsWith(`${root}/`)
        ? f.path.slice(root.length + 1)
        : f.path?.split("/").slice(-2).join("/") ?? "";
    return loc ? `${loc}:${f.line}` : "";
  };

  const ctl = (
    title: string,
    label: string,
    onClick: () => void,
    enabled: boolean,
    primary = false,
  ) => (
    <button
      className={`dbg-ctl${primary ? " primary" : ""}`}
      title={title}
      disabled={!enabled}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="term-panel dbg-panel" style={{ height }}>
      <Splitter dir="y" onDelta={onResize} />
      <div className="term-bar">
        <div className="dbg-head">
          <span className={`dbg-status ${s.status}`}>●</span>
          <span className="dbg-title" title={s.title}>
            {s.title || "Debug"}
          </span>
          <span className={`dbg-state${s.error ? " err" : ""}`}>
            {s.error ? "failed" : s.status === "paused" ? `paused (${s.stopReason})` : s.status}
          </span>
          <span className="dbg-sep" />
          {ctl(`Resume (${formatCombo(comboFor("debug.resume"))})`, "▶", dbgResume, paused, true)}
          {ctl("Pause", "⏸", dbgPause, s.status === "running")}
          {ctl(`Step over (${formatCombo(comboFor("debug.stepOver"))})`, "⤵", dbgStepOver, paused)}
          {ctl(`Step into (${formatCombo(comboFor("debug.stepInto"))})`, "⇣", dbgStepInto, paused)}
          {ctl(`Step out (${formatCombo(comboFor("debug.stepOut"))})`, "⇡", dbgStepOut, paused)}
          {ctl(`Stop (${formatCombo(comboFor("debug.stop"))})`, "■", () => stopDebug(), active)}
          <span className="dbg-sep" />
          <div className="palette-tabs">
            <button className={view === "debugger" ? "on" : ""} onClick={() => setView("debugger")}>
              Debugger
            </button>
            <button className={view === "console" ? "on" : ""} onClick={() => setView("console")}>
              Console
            </button>
          </div>
          {view === "console" && (
            <button className="dbg-ctl" title="Clear console" onClick={clearConsole}>
              ⌫
            </button>
          )}
        </div>
        <button className="term-close" title="Hide debug panel" onClick={onClose}>
          ✕
        </button>
      </div>

      {view === "debugger" ? (
        <div className="dbg-body">
          <div className="dbg-frames">
            <div className="dbg-pane-head">Frames</div>
            <div className="dbg-scroll">
              {s.frames.length === 0 &&
                (s.error ? (
                  <div className="dbg-hint err">{s.error}</div>
                ) : (
                  <div className="dbg-hint">
                    {active ? "Running… waiting for a breakpoint." : "No active session."}
                  </div>
                ))}
              {s.frames.map((f) => (
                <div
                  key={f.id}
                  className={`dbg-frame${s.currentFrame?.id === f.id ? " on" : ""}${f.path ? "" : " nosrc"}`}
                  onClick={() => f.path && selectFrame(f)}
                  title={f.path ?? undefined}
                >
                  <span className="dbg-frame-name">{f.name}</span>
                  <span className="dbg-frame-loc">{frameLabel(f)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dbg-vars">
            <div className="dbg-pane-head">Variables</div>
            <Variables frame={paused ? s.currentFrame : null} />
          </div>
          <div className="dbg-watch-pane">
            <div className="dbg-pane-head">Watches</div>
            <Watches frame={s.currentFrame} paused={paused} />
          </div>
        </div>
      ) : (
        <Console />
      )}
    </div>
  );
}

// Output window for `go test` / `go run` launched via the Run action — a
// read-only console fed by lib/run, with stop + clear controls. Shares the
// debug panel's styling.

import { useEffect, useRef, useState } from "react";
import Splitter from "../components/Splitter";
import { parseAnsi } from "../lib/ansi";
import { clearRun, getRunLines, getRunSnapshot, stopRun, subscribeRun } from "../lib/run";

interface Props {
  height: number;
  onResize: (delta: number) => void;
  onClose: () => void;
}

export default function RunPanel({ height, onResize, onClose }: Props) {
  const [, force] = useState(0);
  useEffect(() => subscribeRun(() => force((n) => n + 1)), []);

  const s = getRunSnapshot();
  const lines = getRunLines();
  const running = s.status === "running";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const stateLabel =
    s.status === "running"
      ? "running"
      : s.status === "exited"
        ? s.exitCode == null
          ? "finished"
          : `exit ${s.exitCode}`
        : "idle";

  return (
    <div className="term-panel dbg-panel" style={{ height }}>
      <Splitter dir="y" onDelta={onResize} />
      <div className="term-bar">
        <div className="dbg-head">
          <span className={`dbg-status ${s.status}`}>●</span>
          <span className="dbg-title" title={s.title}>
            {s.title || "Run"}
          </span>
          <span className={`dbg-state${s.exitCode ? " err" : ""}`}>{stateLabel}</span>
          <span className="dbg-sep" />
          <button className="dbg-ctl" title="Stop" disabled={!running} onClick={() => stopRun()}>
            ■
          </button>
          <button className="dbg-ctl" title="Clear output" onClick={clearRun}>
            ⌫
          </button>
        </div>
        <button className="term-close" title="Hide run panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="dbg-console">
        <div className="dbg-scroll dbg-log" ref={scrollRef}>
          {lines.map((l, i) => {
            const spans = (l.spans ??= parseAnsi(l.text));
            return (
              <span key={i} className={`dbg-line ${l.kind}`}>
                {spans.map((sp, j) =>
                  sp.color || sp.bg || sp.bold || sp.dim || sp.underline ? (
                    <span
                      key={j}
                      style={{
                        color: sp.color,
                        backgroundColor: sp.bg,
                        borderRadius: sp.bg ? 3 : undefined,
                        fontWeight: sp.bold ? 600 : undefined,
                        opacity: sp.dim ? 0.65 : undefined,
                        textDecoration: sp.underline ? "underline" : undefined,
                      }}
                    >
                      {sp.text}
                    </span>
                  ) : (
                    sp.text
                  ),
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Dropdown for the Run / Debug header buttons: the recent (and pinned)
// executions. Each row replays on click, can be pinned (kept past the 5-recent
// cap), and edited inline to add go-tool args, env vars, and tags.

import { useEffect, useState } from "react";
import {
  listExec,
  removeEntry,
  subscribeExec,
  togglePin,
  updateEntry,
  type ExecEntry,
  type ExecKind,
} from "../lib/execHistory";
import { startRun } from "../lib/run";
import { startDebug } from "../lib/debug";

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

// Classify an execution for its row badge. Debug entries carry an explicit
// test/debug mode; run entries are inferred from the subcommand (go/cargo test,
// build, …).
function badgeFor(e: ExecEntry): { glyph: string; title: string; cls: string } {
  if (e.kind === "debug") {
    return e.mode === "test"
      ? { glyph: "🧪", title: "Test (debug)", cls: "test" }
      : { glyph: "🐞", title: "Debug", cls: "debug" };
  }
  const sub = e.args[0];
  if (sub === "test") return { glyph: "🧪", title: "Test", cls: "test" };
  if (sub === "build" || sub === "install" || sub === "vet") return { glyph: "🔨", title: "Build", cls: "build" };
  return { glyph: "▶", title: "Run", cls: "run" };
}

interface Props {
  kind: ExecKind;
  onClose: () => void;
}

export default function ExecMenu({ kind, onClose }: Props) {
  const [, force] = useState(0);
  useEffect(() => subscribeExec(() => force((n) => n + 1)), []);
  const entries = listExec(kind);
  const [editId, setEditId] = useState<string | null>(null);

  const run = (e: ExecEntry) => {
    if (e.kind === "run") startRun({ cwd: e.cwd, label: e.label, program: e.program, args: e.args, env: e.env });
    else startDebug({ root: e.root, name: e.label, mode: e.mode, program: e.program, args: e.args, env: e.env });
    onClose();
  };

  return (
    <>
      <div className="ctx-backdrop" onClick={onClose} onContextMenu={(ev) => { ev.preventDefault(); onClose(); }} />
      <div className="exec-menu" onClick={(e) => e.stopPropagation()}>
        {entries.length === 0 ? (
          <div className="exec-empty">No recent {kind === "run" ? "runs" : "debug sessions"} yet.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="exec-row">
              <div className="exec-main">
                <button
                  className={`exec-pin${e.pinned ? " on" : ""}`}
                  title={e.pinned ? "Unpin" : "Pin (keep in the list)"}
                  onClick={() => togglePin(kind, e.id)}
                >
                  {e.pinned ? "★" : "☆"}
                </button>
                <button className="exec-label" title={`Run: ${e.program} ${e.args.join(" ")}`} onClick={() => run(e)}>
                  {(() => {
                    const b = badgeFor(e);
                    return (
                      <span className={`exec-badge ${b.cls}`} title={b.title} aria-label={b.title}>
                        {b.glyph}
                      </span>
                    );
                  })()}
                  <span className="exec-cmd">{e.label}</span>
                  {e.tags.length > 0 && (
                    <span className="exec-tags">
                      {e.tags.map((t) => (
                        <span key={t} className="exec-tag">{t}</span>
                      ))}
                    </span>
                  )}
                  {Object.keys(e.env).length > 0 && <span className="exec-envdot" title="has env vars">env</span>}
                </button>
                <button
                  className="exec-edit"
                  title="Edit args, env vars, tags"
                  onClick={() => setEditId((id) => (id === e.id ? null : e.id))}
                >
                  ✎
                </button>
                <button className="exec-del" title="Remove from list" onClick={() => removeEntry(kind, e.id)}>
                  ✕
                </button>
              </div>
              {editId === e.id && <EditForm entry={e} kind={kind} onDone={() => setEditId(null)} />}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function EditForm({ entry, kind, onDone }: { entry: ExecEntry; kind: ExecKind; onDone: () => void }) {
  const [args, setArgs] = useState(entry.args.join(" "));
  const [env, setEnv] = useState(envToText(entry.env));
  const [tags, setTags] = useState(entry.tags.join(", "));

  const save = () => {
    updateEntry(kind, entry.id, {
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: parseEnv(env),
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    });
    onDone();
  };

  return (
    <div className="exec-edit-form">
      <label>
        Arguments
        <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="test -v ./..." spellCheck={false} />
      </label>
      <label>
        Env vars (one KEY=VALUE per line)
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder={"CGO_ENABLED=0\nLOG_LEVEL=debug"} spellCheck={false} />
      </label>
      <label>
        Tags (comma-separated)
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ci, fast" spellCheck={false} />
      </label>
      <div className="exec-edit-actions">
        <button className="tbtn" onClick={onDone}>Cancel</button>
        <button className="tbtn primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}

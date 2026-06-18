import { useEffect, useRef, useState } from "react";
import type { MonitorRow } from "../lib/types";
import { basename, dirname } from "../lib/util";

interface Props {
  monitors: MonitorRow[];
  selected: number | null;
  deletingId: number | null;
  onSelect: (id: number) => void;
  onRemove: (m: MonitorRow) => void;
}

export default function ProjectPicker({ monitors, selected, deletingId, onSelect, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQ("");
  }, [open]);

  const cur = monitors.find((m) => m.id === selected) ?? null;
  const ql = q.trim().toLowerCase();
  const list = ql ? monitors.filter((m) => m.root_path.toLowerCase().includes(ql)) : monitors;

  const choose = (id: number) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div className="projpick">
      <button
        className="projpick-trigger"
        onClick={() => setOpen((o) => !o)}
        title={cur?.root_path ?? "No project tracked"}
      >
        <span className={`projpick-live${cur ? " on" : ""}`} />
        <span className="projpick-cur">{cur ? basename(cur.root_path) || cur.root_path : "No project"}</span>
        <span className="projpick-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="ctx-backdrop" onClick={() => setOpen(false)} />
          <div className="projpick-menu" onClick={(e) => e.stopPropagation()}>
            <div className="projpick-head">
              <input
                ref={inputRef}
                value={q}
                placeholder="Filter projects…"
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <div className="projpick-list">
              {list.length === 0 ? (
                <div className="projpick-empty">
                  {monitors.length === 0 ? "No projects tracked yet" : "No matching projects"}
                </div>
              ) : (
                list.map((m) => {
                  const deleting = deletingId === m.id;
                  const on = m.id === selected;
                  return (
                    <div key={m.id} className={`projpick-row${on ? " on" : ""}${deleting ? " deleting" : ""}`}>
                      <button
                        className="projpick-pick"
                        onClick={() => !deleting && choose(m.id)}
                        title={m.root_path}
                        disabled={deleting}
                      >
                        <span className={`projpick-live${on ? " on" : ""}`} />
                        <span className="projpick-meta">
                          <span className="projpick-name">{basename(m.root_path) || m.root_path}</span>
                          <span className="projpick-path">{deleting ? "Deleting history…" : dirname(m.root_path)}</span>
                        </span>
                        {m.source !== "manual" && !deleting && <span className="projpick-src">{m.source}</span>}
                      </button>
                      {deleting ? (
                        <span className="spinner" aria-label="Deleting" />
                      ) : (
                        <button
                          className="row-x row-del"
                          title="Remove project & all history"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemove(m);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

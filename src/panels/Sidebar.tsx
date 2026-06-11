import type { MonitorRow } from "../lib/types";
import { basename, dirname } from "../lib/util";

interface Props {
  monitors: MonitorRow[];
  selected: number | null;
  deletingId: number | null;
  onSelect: (id: number) => void;
  onAdd: () => void;
  onToggle: (m: MonitorRow) => void;
  onDelete: (m: MonitorRow) => void;
}

export default function Sidebar({ monitors, selected, deletingId, onSelect, onAdd, onToggle, onDelete }: Props) {
  return (
    <div className="col">
      <div className="col-head">
        <h2>Monitored</h2>
        <button className="tbtn" onClick={onAdd} title="Track a folder">
          + Folder
        </button>
      </div>
      <div className="col-scroll">
        {monitors.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: "32px 20px" }}>
            <p>No folders tracked yet. Add one, or open a project in VSCode / Zed.</p>
          </div>
        )}
        {monitors.map((m) => {
          const deleting = deletingId === m.id;
          return (
            <div
              key={m.id}
              className={`folder${m.active ? " active" : ""}${selected === m.id ? " on" : ""}${deleting ? " deleting" : ""}`}
              onClick={() => !deleting && onSelect(m.id)}
            >
              <span className="live" />
              <div className="meta">
                <div className="name">{basename(m.root_path) || m.root_path}</div>
                <div className="path">{deleting ? "Deleting history…" : dirname(m.root_path)}</div>
              </div>
              {!deleting && m.source !== "manual" && <span className="src-chip">{m.source}</span>}
              {deleting ? (
                <span className="spinner" aria-label="Deleting" />
              ) : (
                <>
                  <button
                    className="row-x"
                    title={m.active ? "Stop tracking (keep history)" : "Start tracking"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(m);
                    }}
                  >
                    {m.active ? "⏸" : "▶"}
                  </button>
                  <button
                    className="row-x row-del"
                    title="Delete folder & all history"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(m);
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

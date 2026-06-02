import type { MonitorRow } from "../lib/types";
import { basename, dirname } from "../lib/util";

interface Props {
  monitors: MonitorRow[];
  selected: number | null;
  onSelect: (id: number) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
}

export default function Sidebar({ monitors, selected, onSelect, onAdd, onRemove }: Props) {
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
        {monitors.map((m) => (
          <div
            key={m.id}
            className={`folder${m.active ? " active" : ""}${selected === m.id ? " on" : ""}`}
            onClick={() => onSelect(m.id)}
          >
            <span className="live" />
            <div className="meta">
              <div className="name">{basename(m.root_path) || m.root_path}</div>
              <div className="path">{dirname(m.root_path)}</div>
            </div>
            {m.source !== "manual" && <span className="src-chip">{m.source}</span>}
            <button
              className="row-x"
              title="Stop tracking & delete history"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(m.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

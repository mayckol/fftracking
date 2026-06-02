import { useMemo } from "react";
import type { ChangeSummary, SnapshotRow } from "../lib/types";
import { dayLabel, fmtTime } from "../lib/util";

interface Props {
  snapshots: SnapshotRow[];
  summaries?: Record<number, ChangeSummary>;
  selected: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onLabel: (id: number, current: string | null) => void;
}

export default function Timeline({ snapshots, summaries, selected, onSelect, onDelete, onLabel }: Props) {
  const groups = useMemo(() => {
    const out: { day: string; rows: SnapshotRow[] }[] = [];
    for (const s of snapshots) {
      const last = out[out.length - 1];
      if (last && last.day === s.day_bucket) last.rows.push(s);
      else out.push({ day: s.day_bucket, rows: [s] });
    }
    return out;
  }, [snapshots]);

  if (snapshots.length === 0) {
    return (
      <div className="empty" style={{ padding: "32px 20px" }}>
        <p>No breaking points yet. Edits to this folder are captured automatically.</p>
      </div>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <div className="day-group" key={g.day}>
          <div className="day-label">
            {dayLabel(g.day)}
            <span className="count">{g.rows.length}</span>
          </div>
          {g.rows.map((s, i) => (
            <div
              key={s.id}
              className={`bp${selected === s.id ? " on" : ""}`}
              style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
              onClick={() => onSelect(s.id)}
            >
              <div className="rail">
                <span className="node" />
              </div>
              <div className="body">
                <div className="time">
                  {s.label ? <span className="bp-label">{s.label}</span> : fmtTime(s.ts)}
                </div>
                <div className="sub">
                  <span className={`trig ${s.trigger}`}>{s.trigger.replace("_", " ")}</span>
                  {s.label && <span className="changecount">{fmtTime(s.ts)}</span>}
                  {(() => {
                    const sum = summaries?.[s.id];
                    if (sum && (sum.added || sum.modified || sum.deleted)) {
                      return (
                        <span className="sum" title="Changes vs the comparison base">
                          {sum.added > 0 && <span className="sum-pill add">+{sum.added}</span>}
                          {sum.modified > 0 && <span className="sum-pill mod">~{sum.modified}</span>}
                          {sum.deleted > 0 && <span className="sum-pill del">−{sum.deleted}</span>}
                        </span>
                      );
                    }
                    return <span className="changecount">{s.file_count} files</span>;
                  })()}
                </div>
              </div>
              <button
                className="row-x"
                title="Label this breaking point"
                onClick={(e) => {
                  e.stopPropagation();
                  onLabel(s.id, s.label);
                }}
              >
                🏷
              </button>
              <button
                className="row-x row-del"
                title="Delete this breaking point"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

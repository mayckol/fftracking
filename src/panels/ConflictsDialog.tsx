import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/ipc";
import ConfirmModal from "../components/ConfirmModal";
import { basename } from "../lib/util";
import type { ConflictFile, MergeState } from "../lib/types";

interface Props {
  repoPath: string;
  state: MergeState;
  toast: (msg: string, error?: boolean) => void;
  onMerge: (path: string) => void;
  onReload: () => Promise<MergeState>;
  onClose: () => void;
}

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function ConflictsDialog({ repoPath, state, toast, onMerge, onReload, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(state.files[0]?.path ?? null);
  const [grouped, setGrouped] = useState(false);
  const [busy, setBusy] = useState(false);
  // Accept-yours/theirs takes one whole side and discards the other, so confirm first.
  const [confirmSide, setConfirmSide] = useState<"ours" | "theirs" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Nothing left to resolve (e.g. the last file was merged in its own window) —
  // close instead of lingering on an empty list.
  useEffect(() => {
    if (state.files.length === 0) onClose();
  }, [state.files.length, onClose]);

  const groups = useMemo(() => {
    if (!grouped) return [{ dir: "", files: state.files }];
    const map = new Map<string, ConflictFile[]>();
    for (const f of state.files) {
      const d = dirOf(f.path);
      (map.get(d) ?? map.set(d, []).get(d)!).push(f);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => ({ dir, files }));
  }, [grouped, state.files]);

  async function accept(side: "ours" | "theirs") {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.gitAcceptSide(repoPath, selected, side);
      toast(`Accepted ${side === "ours" ? "yours" : "theirs"} for ${basename(selected)}`);
      const next = await onReload();
      if (next.files.length === 0) onClose();
      else setSelected(next.files[0].path);
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const row = (f: ConflictFile) => (
    <div
      key={f.path}
      className={`cfl-row${selected === f.path ? " on" : ""}`}
      onClick={() => setSelected(f.path)}
      onDoubleClick={() => onMerge(f.path)}
      title={f.path}
    >
      <span className="cfl-name">
        <span className="cfl-base">{basename(f.path)}</span>
        {!grouped && dirOf(f.path) && <span className="cfl-dir">{dirOf(f.path)}</span>}
      </span>
      <span className={`cfl-stat ${f.ours}`}>{cap(f.ours)}</span>
      <span className={`cfl-stat ${f.theirs}`}>{cap(f.theirs)}</span>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cfl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cfl-head">
          <h3>Conflicts</h3>
          <span className="cfl-sub">
            Merging branch <b>{state.theirs_label}</b> into branch <b>{state.ours_label}</b>
          </span>
        </div>

        <div className="cfl-body">
          <div className="cfl-table">
            <div className="cfl-thead">
              <span className="cfl-name">Name</span>
              <span className="cfl-stat">Yours ({state.ours_label})</span>
              <span className="cfl-stat">Theirs ({state.theirs_label})</span>
            </div>
            <div className="cfl-list">
              {groups.map((g) => (
                <div key={g.dir || "_root"}>
                  {grouped && g.dir && <div className="cfl-group">{g.dir || "/"}</div>}
                  {g.files.map(row)}
                </div>
              ))}
              {state.files.length === 0 && <div className="cfl-empty">No conflicts remaining.</div>}
            </div>
          </div>

          <div className="cfl-side">
            <button className="tbtn" disabled={!selected || busy} onClick={() => setConfirmSide("ours")}>
              Accept Yours
            </button>
            <button className="tbtn" disabled={!selected || busy} onClick={() => setConfirmSide("theirs")}>
              Accept Theirs
            </button>
            <button className="tbtn primary" disabled={!selected} onClick={() => selected && onMerge(selected)}>
              Merge…
            </button>
          </div>
        </div>

        {confirmSide && selected && (
          <ConfirmModal
            title={confirmSide === "ours" ? "Accept yours" : "Accept theirs"}
            danger
            message={
              <>
                Resolve <b>{basename(selected)}</b> by taking the entire{" "}
                <b>{confirmSide === "ours" ? `“yours” (${state.ours_label})` : `“theirs” (${state.theirs_label})`}</b>{" "}
                side and discarding the other. Continue?
              </>
            }
            confirmLabel={confirmSide === "ours" ? "Accept Yours" : "Accept Theirs"}
            onConfirm={() => {
              const side = confirmSide;
              setConfirmSide(null);
              accept(side);
            }}
            onCancel={() => setConfirmSide(null)}
          />
        )}

        <div className="cfl-foot">
          <label className="cfl-check">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
            Group files by directory
          </label>
          <button className="tbtn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

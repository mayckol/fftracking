import { useCallback, useEffect, useRef, useState } from "react";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import { api } from "../lib/ipc";
import type { FileChange, HunkInfo, SnapshotRow } from "../lib/types";
import { basename, dirname, langOf } from "../lib/util";
import ChangedTree from "./ChangedTree";
import Timeline from "./Timeline";

type Mode = "before" | "now";

interface Props {
  monitorId: number;
  toast: (msg: string, error?: boolean) => void;
}

export default function HistoryView({ monitorId, toast }: Props) {
  const [snaps, setSnaps] = useState<SnapshotRow[]>([]);
  const [snap, setSnap] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  // Default to "before" so the diff matches the Changed Files deltas (what
  // changed AT this point). Toggle to "now" for per-block revert vs the tree.
  const [mode, setMode] = useState<Mode>("before");
  const [inline, setInline] = useState(false);
  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const diffApi = useRef<DiffHandle>(null);
  // window.prompt/confirm don't work in the Tauri webview — use a custom modal.
  const [dialog, setDialog] = useState<
    { kind: "label"; id: number; value: string } | { kind: "folder"; prefix: string; remove: boolean } | null
  >(null);

  const loadSnaps = useCallback(
    async (keep?: number) => {
      const rows = await api.listSnapshots(monitorId);
      setSnaps(rows);
      setSnap((cur) => keep ?? cur ?? (rows[0]?.id ?? null));
    },
    [monitorId],
  );

  useEffect(() => {
    setSnap(null);
    setFile(null);
    loadSnaps();
  }, [monitorId, loadSnaps]);

  // New breaking points (event/interval) land in the DB while watching — poll
  // so the timeline reflects them live without re-selecting the folder.
  useEffect(() => {
    const t = window.setInterval(() => loadSnaps(), 3000);
    return () => window.clearInterval(t);
  }, [loadSnaps]);

  // Resolve baseline + changed files for the selected breaking point.
  useEffect(() => {
    if (snap == null) {
      setChanges([]);
      return;
    }
    let alive = true;
    (async () => {
      const prev = await api.previousSnapshot(snap);
      if (!alive) return;
      setBaseline(prev);
      const list = prev
        ? await api.changedFiles(prev, snap)
        : (await api.snapshotFiles(snap)).map((path) => ({ path, status: "added" as const }));
      if (!alive) return;
      setChanges(list);
      setFile((cur) => (cur && list.some((c) => c.path === cur) ? cur : list[0]?.path ?? null));
    })();
    return () => {
      alive = false;
    };
  }, [snap]);

  // Load both sides of the diff + the per-block hunks for the selected file.
  // Hunks come from the displayed (left vs right) diff, so the ⟲ icon appears
  // on every shown change and reverts that block toward the left side.
  const loadDiff = useCallback(async () => {
    if (snap == null || !file) {
      setLeft("");
      setRight("");
      setHunks([]);
      return;
    }
    let l = "";
    let r = "";
    if (mode === "before") {
      l = (baseline ? await api.fileAt(baseline, file) : "") ?? "";
      r = (await api.fileAt(snap, file)) ?? "";
    } else {
      l = (await api.fileAt(snap, file)) ?? "";
      r = (await api.workingFile(monitorId, file)) ?? "";
    }
    setLeft(l);
    setRight(r);
    setHunks(await api.textHunks(l, r));
  }, [snap, file, mode, baseline, monitorId]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  async function afterRevert(msg: string) {
    toast(msg);
    await loadSnaps(snap ?? undefined);
    await loadDiff();
  }

  async function revertFile() {
    if (snap == null || !file) return;
    try {
      await api.revertFile(snap, file);
      await afterRevert(`Reverted ${basename(file)} to this point`);
    } catch (e) {
      toast(String(e), true);
    }
  }

  function revertFolder() {
    if (snap == null || !file) return;
    setDialog({ kind: "folder", prefix: dirname(file).replace(/\/$/, ""), remove: false });
  }

  async function deleteSnap(id: number) {
    try {
      await api.deleteSnapshot(id);
      if (snap === id) setSnap(null);
      await loadSnaps(snap === id ? undefined : snap ?? undefined);
      toast("Breaking point deleted");
    } catch (e) {
      toast(String(e), true);
    }
  }

  // Persist an in-diff edit / gutter-revert (vs-now mode) to the working tree.
  async function persistWorking(value: string) {
    if (snap == null || !file) return;
    try {
      await api.writeWorkingFile(monitorId, file, value);
      setRight(value);
      toast(`Saved ${basename(file)}`);
      await loadSnaps(snap ?? undefined);
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function revertPath(path: string) {
    if (snap == null) return;
    try {
      await api.revertFile(snap, path);
      await afterRevert(`Reverted ${basename(path)} to this point`);
    } catch (e) {
      toast(String(e), true);
    }
  }

  function revertFolderPath(prefix: string) {
    setDialog({ kind: "folder", prefix, remove: false });
  }

  function labelSnap(id: number, current: string | null) {
    setDialog({ kind: "label", id, value: current ?? "" });
  }

  async function applyLabel() {
    if (dialog?.kind !== "label") return;
    try {
      await api.setSnapshotLabel(dialog.id, dialog.value);
      await loadSnaps(snap ?? undefined);
    } catch (e) {
      toast(String(e), true);
    }
    setDialog(null);
  }

  async function applyFolderRevert() {
    if (dialog?.kind !== "folder" || snap == null) return;
    try {
      await api.revertFolder(snap, dialog.prefix, dialog.remove);
      await afterRevert(`Reverted folder ${dialog.prefix || "/"}`);
    } catch (e) {
      toast(String(e), true);
    }
    setDialog(null);
  }

  // Revert one shown change (gutter ⟲) toward the left side, into the tree.
  async function revertScope(index: number) {
    if (!file) return;
    try {
      await api.applyTextRevert(monitorId, file, left, right, [index]);
      toast(`Reverted change in ${basename(file)}`);
      await loadSnaps(snap ?? undefined);
      // The revert always writes the working tree. In "vs before" the panes show
      // two past snapshots (unchanged), so switch to "vs now" to show the result.
      if (mode === "before") setMode("now");
      else await loadDiff();
    } catch (e) {
      toast(String(e), true);
    }
  }

  if (snaps.length === 0) {
    return (
      <div className="col main">
        <div className="empty">
          <img className="hero-logo" src="/logo.png" alt="fftracking" />
          <h3>No breaking points</h3>
          <p>Edit a file in this folder and a breaking point appears here automatically. You can also snapshot manually from the top bar.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="col">
        <div className="col-head">
          <h2>Breaking Points</h2>
        </div>
        <div className="split">
          <div className="col" style={{ borderRight: "none" }}>
            <div className="col-scroll">
              <Timeline
                snapshots={snaps}
                selected={snap}
                onSelect={setSnap}
                onDelete={deleteSnap}
                onLabel={labelSnap}
              />
            </div>
          </div>
          <div className="col" style={{ borderRight: "none" }}>
            <div className="col-head">
              <h2>Changed Files</h2>
              <span className="changecount">{changes.length}</span>
            </div>
            <div className="col-scroll">
              <ChangedTree
                changes={changes}
                selected={file}
                onSelect={setFile}
                onRevertFile={revertPath}
                onRevertFolder={revertFolderPath}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="col main">
        {file ? (
          <>
            <div className="diff-head">
              <span className="file" title={file}>
                {file}
              </span>
              <button className="tbtn" title="Previous change" onClick={() => diffApi.current?.navigate("prev")}>
                ↑
              </button>
              <button className="tbtn" title="Next change" onClick={() => diffApi.current?.navigate("next")}>
                ↓
              </button>
              <button
                className="tbtn"
                onClick={() => setMode(mode === "before" ? "now" : "before")}
                title="What to compare against"
              >
                {mode === "before" ? "↔ vs before" : "↔ vs now"}
              </button>
              <button
                className="tbtn"
                onClick={() => setInline(!inline)}
                title="Diff layout: side-by-side or inline"
              >
                {inline ? "≣ inline" : "⇆ split"}
              </button>
              {hunks.length > 0 && (
                <span className="changecount" title="Click the ⟲ icon in the gutter to revert that block">
                  {hunks.length} change{hunks.length === 1 ? "" : "s"} · ⟲ in gutter to revert
                </span>
              )}
              <div className="diff-actions">
                <button className="tbtn" onClick={revertFile}>
                  Revert file
                </button>
                <button className="tbtn danger" onClick={revertFolder}>
                  Revert folder
                </button>
              </div>
            </div>
            <DiffEditor
              original={left}
              modified={right}
              language={langOf(file)}
              inline={inline}
              editable={mode === "now"}
              onCommit={persistWorking}
              hunks={hunks}
              onRevertHunk={revertScope}
              ref={diffApi}
            />
          </>
        ) : (
          <div className="empty">
            <div className="glyph">⟷</div>
            <h3>Select a file</h3>
            <p>Pick a breaking point, then a changed file to see the diff.</p>
          </div>
        )}
      </div>

      {dialog?.kind === "label" && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Label breaking point</h3>
            <input
              autoFocus
              value={dialog.value}
              placeholder="e.g. before refactor"
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyLabel();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <div className="modal-actions">
              <button className="tbtn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="tbtn primary" onClick={applyLabel}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === "folder" && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Revert folder</h3>
            <p>
              Restore everything under <b>{dialog.prefix || "/"}</b> to this breaking point.
            </p>
            <label className="modal-check">
              <input
                type="checkbox"
                checked={dialog.remove}
                onChange={(e) => setDialog({ ...dialog, remove: e.target.checked })}
              />
              Also delete files that did not exist at this point
            </label>
            <div className="modal-actions">
              <button className="tbtn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="tbtn primary" onClick={applyFolderRevert}>
                Revert folder
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

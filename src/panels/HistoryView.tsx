import { useCallback, useEffect, useRef, useState } from "react";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import { api } from "../lib/ipc";
import type { ChangeSummary, FileChange, HunkInfo, SnapshotRow } from "../lib/types";
import { basename, dayLabel, dirname, fmtTime, langOf } from "../lib/util";
import { useShortcut } from "../lib/shortcuts";
import { isConfirmSuppressed } from "../lib/confirmPrefs";
import ConfirmModal from "../components/ConfirmModal";
import ChangedTree from "./ChangedTree";
import Timeline from "./Timeline";

interface Props {
  monitorId: number;
  toast: (msg: string, error?: boolean) => void;
}

export default function HistoryView({ monitorId, toast }: Props) {
  const [snaps, setSnaps] = useState<SnapshotRow[]>([]);
  const [snap, setSnap] = useState<number | null>(null);
  const [summaries, setSummaries] = useState<Record<number, ChangeSummary>>({});
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [inline, setInline] = useState(false);
  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [revertAllId, setRevertAllId] = useState<number | null>(null);
  // What the changed-files list and diff compare the selected point against:
  // "point" = the changes this breaking point introduced (vs the git branch or
  // the previous point — the same base the timeline badges use), "current" =
  // drift between the point and the live working tree (JetBrains Local History).
  const [vsMode, setVsMode] = useState<"point" | "current">("point");
  const diffApi = useRef<DiffHandle>(null);
  const summariesKey = useRef("");
  const diffReq = useRef(0);
  // window.prompt/confirm don't work in the Tauri webview — use a custom modal.
  const [dialog, setDialog] = useState<
    | { kind: "label"; id: number; value: string }
    | { kind: "folder"; prefix: string; remove: boolean }
    | null
  >(null);

  const loadSnaps = useCallback(
    async (keep?: number) => {
      const rows = await api.listSnapshots(monitorId);
      setSnaps(rows);
      setSnap((cur) => keep ?? cur ?? (rows[0]?.id ?? null));
      // Badges (vs the previous point) only change when the point set does.
      const key = rows.map((r) => r.id).join(",");
      if (key !== summariesKey.current) {
        summariesKey.current = key;
        try {
          const sums = await api.snapshotSummaries(monitorId);
          setSummaries(Object.fromEntries(sums.map((s) => [s.id, s])));
        } catch {
          setSummaries({});
        }
      }
    },
    [monitorId],
  );

  useEffect(() => {
    setSnap(null);
    setFile(null);
    summariesKey.current = "";
    loadSnaps();
  }, [monitorId, loadSnaps]);

  // New breaking points (event/interval) land in the DB while watching — poll
  // so the timeline reflects them live without re-selecting the folder.
  useEffect(() => {
    const t = window.setInterval(() => loadSnaps(), 3000);
    return () => window.clearInterval(t);
  }, [loadSnaps]);

  // List the files for the selected mode — the same pair the diff shows, so a
  // row always opens a real diff. "point" matches the timeline badges (what
  // this point changed); "current" is the point↔working-tree drift.
  useEffect(() => {
    if (snap == null) {
      setChanges([]);
      return;
    }
    let alive = true;
    (async () => {
      const list =
        vsMode === "current"
          ? await api.snapshotWorkingChanges(monitorId, snap)
          : await api.breakingPointChanges(monitorId, snap);
      if (!alive) return;
      setChanges(list);
      setFile((cur) => (cur && list.some((c) => c.path === cur) ? cur : list[0]?.path ?? null));
    })();
    return () => {
      alive = false;
    };
  }, [snap, monitorId, reload, vsMode]);

  // The two panes depend on the mode. "current": LEFT = the file as captured
  // at the point ("Before", read-only), RIGHT = the live working tree
  // ("Current", editable) — the ⟲ gutter icon restores a block from Before
  // into Current and the edit is undoable (⌘Z / Ctrl+Z). "point": LEFT = the
  // base (git branch / previous point), RIGHT = the point's capture, both
  // read-only — what this breaking point changed.
  const loadDiff = useCallback(async () => {
    // Monotonic token: a slower in-flight load must not clobber the panes (and
    // the hunk indices that drive gutter-revert) of a newer selection.
    const req = ++diffReq.current;
    if (snap == null || !file) {
      setLeft("");
      setRight("");
      setHunks([]);
      return;
    }
    const [l, r] =
      vsMode === "current"
        ? [(await api.fileAt(snap, file)) ?? "", (await api.workingFile(monitorId, file)) ?? ""]
        : [(await api.baseFile(monitorId, snap, file)) ?? "", (await api.fileAt(snap, file)) ?? ""];
    const hk = await api.textHunks(l, r);
    if (req !== diffReq.current) return;
    setLeft(l);
    setRight(r);
    setHunks(hk);
  }, [snap, file, monitorId, vsMode]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  // When a breaking point / file loads, jump the diff to its first change so the
  // user lands on what actually changed instead of the top of the file.
  useEffect(() => {
    if (snap == null || !file) return;
    const t = window.setTimeout(() => diffApi.current?.focusFirst(), 180);
    return () => window.clearTimeout(t);
  }, [snap, file]);

  async function afterRevert(msg: string) {
    toast(msg);
    await loadSnaps(snap ?? undefined);
    setReload((n) => n + 1);
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
    openFolder(dirname(file).replace(/\/$/, ""));
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
  // We update `right` to the value the editor already holds (no model reset, so
  // native undo/redo survives) and refresh the gutter hunks for the new content.
  async function persistWorking(value: string) {
    if (snap == null || !file) return;
    try {
      await api.writeWorkingFile(monitorId, file, value);
      setRight(value);
      api.textHunks(left, value).then(setHunks).catch(() => {});
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
    openFolder(prefix);
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

  async function runFolder(prefix: string, remove: boolean) {
    if (snap == null) return;
    try {
      await api.revertFolder(snap, prefix, remove);
      await afterRevert(`Reverted folder ${prefix || "/"} to this point`);
    } catch (e) {
      toast(String(e), true);
    }
  }

  function openFolder(prefix: string) {
    if (isConfirmSuppressed("revertFolder")) runFolder(prefix, false);
    else setDialog({ kind: "folder", prefix, remove: false });
  }

  async function ignorePath(path: string, isDir: boolean) {
    const glob = isDir ? `${path}/**` : path;
    try {
      const cur = await api.getSettings();
      if (cur.ignore_globs.includes(glob)) {
        toast(`Already ignoring ${glob}`);
        return;
      }
      await api.setSetting("ignore_globs", [...cur.ignore_globs, glob].join("\n"));
      toast(`Ignoring ${glob}`);
      setFile((cur2) => (cur2 === path || (isDir && cur2?.startsWith(`${path}/`)) ? null : cur2));
      setReload((n) => n + 1);
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function doRevertAll(id: number) {
    try {
      // Whole monitor root, mirror the point exactly (delete files added since).
      await api.revertFolder(id, "", true);
      setSnap(id);
      await loadSnaps(id);
      setReload((n) => n + 1);
      await loadDiff();
      toast("Reverted everything to this breaking point");
    } catch (e) {
      toast(String(e), true);
    }
  }

  function askRevertAll(id: number) {
    if (isConfirmSuppressed("revertAll")) doRevertAll(id);
    else setRevertAllId(id);
  }

  function gotoPoint(delta: number) {
    if (snaps.length === 0) return;
    const idx = snaps.findIndex((s) => s.id === snap);
    const next = Math.min(snaps.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
    setSnap(snaps[next].id);
  }

  async function copyToClipboard(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${what}`);
    } catch (e) {
      toast(String(e), true);
    }
  }

  useShortcut("diff.next", () => diffApi.current?.navigate("next"), !!file);
  useShortcut("diff.prev", () => diffApi.current?.navigate("prev"), !!file);
  useShortcut("diff.layout", () => setInline((v) => !v), !!file);
  useShortcut("diff.revertBlock", () => diffApi.current?.revertCurrent(), !!file);
  useShortcut("diff.undo", () => diffApi.current?.undo(), !!file);
  useShortcut("diff.redo", () => diffApi.current?.redo(), !!file);
  useShortcut("revert.file", revertFile, !!file);
  useShortcut("file.copyPath", () => file && copyToClipboard(file, "path"), !!file);
  useShortcut(
    "file.copyContent",
    async () => {
      if (!file) return;
      copyToClipboard((await api.workingFile(monitorId, file)) ?? "", basename(file));
    },
    !!file,
  );
  useShortcut(
    "file.reveal",
    () => file && api.revealPath(monitorId, file).catch((e) => toast(String(e), true)),
    !!file,
  );
  useShortcut(
    "file.open",
    () => file && api.openPath(monitorId, file).catch((e) => toast(String(e), true)),
    !!file,
  );
  useShortcut("nav.nextPoint", () => gotoPoint(1));
  useShortcut("nav.prevPoint", () => gotoPoint(-1));

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

  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const c of changes) counts[c.status]++;
  const sel = snaps.find((s) => s.id === snap);
  const beforeLabel = sel ? `${dayLabel(sel.day_bucket)}, ${fmtTime(sel.ts)}` : "Before";

  return (
    <>
      <div className="col">
        <div className="col-head">
          <h2>Breaking Points</h2>
          <span className="base-tag" title="Change badges show what each point changed vs the one before it">
            ↔ previous point
          </span>
        </div>
        <div className="split">
          <div className="col" style={{ borderRight: "none" }}>
            <div className="col-scroll">
              <Timeline
                snapshots={snaps}
                summaries={summaries}
                selected={snap}
                onSelect={setSnap}
                onDelete={deleteSnap}
                onLabel={labelSnap}
                onRevertAll={askRevertAll}
              />
            </div>
          </div>
          <div className="col" style={{ borderRight: "none" }}>
            <div className="col-head">
              <h2>Changed Files</h2>
              <button
                className="vs-tag"
                title={
                  vsMode === "point"
                    ? "Showing what this breaking point changed (vs the previous point). Click to compare with the current working tree."
                    : "Showing how the current working tree differs from this point. Click to see what the point changed."
                }
                onClick={() => setVsMode((m) => (m === "point" ? "current" : "point"))}
              >
                {vsMode === "point" ? "at this point ⇄" : "vs current ⇄"}
              </button>
              {changes.length > 0 ? (
                <span className="sum">
                  {counts.added > 0 && <span className="sum-pill add">+{counts.added}</span>}
                  {counts.modified > 0 && <span className="sum-pill mod">~{counts.modified}</span>}
                  {counts.deleted > 0 && <span className="sum-pill del">−{counts.deleted}</span>}
                </span>
              ) : (
                <span className="changecount">0</span>
              )}
            </div>
            <div className="col-scroll">
              <ChangedTree
                changes={changes}
                selected={file}
                onSelect={setFile}
                onRevertFile={revertPath}
                onRevertFolder={revertFolderPath}
                onIgnoreFile={(p) => ignorePath(p, false)}
                onIgnoreFolder={(p) => ignorePath(p, true)}
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
              <button className="tbtn" title="Undo (in this diff)" onClick={() => diffApi.current?.undo()}>
                ↶
              </button>
              <button className="tbtn" title="Redo (in this diff)" onClick={() => diffApi.current?.redo()}>
                ↷
              </button>
              <button
                className="tbtn"
                onClick={() => setInline(!inline)}
                title="Diff layout: side-by-side or inline"
              >
                {inline ? "≣ inline" : "⇆ split"}
              </button>
              {hunks.length > 0 && (
                <span
                  className="changecount"
                  title={
                    vsMode === "current"
                      ? "Click the ⟲ icon in the gutter to restore that block to this breaking point; ⌘Z / Ctrl+Z to undo"
                      : "Changes this breaking point introduced"
                  }
                >
                  {hunks.length} change{hunks.length === 1 ? "" : "s"}
                  {vsMode === "current" && " · ⟲ in gutter to revert · ⌘Z undo"}
                </span>
              )}
              <div className="diff-actions">
                <button className="tbtn" onClick={revertFile} title="Restore this file to the selected breaking point">
                  Revert file
                </button>
                <button className="tbtn danger" onClick={revertFolder} title="Restore this folder to the selected breaking point">
                  Revert folder
                </button>
              </div>
            </div>
            {!inline && (
              <div className="pane-labels">
                {vsMode === "current" ? (
                  <>
                    <span className="pane-label before" title="Read-only: the file as captured at this breaking point">
                      🔒 Before · {beforeLabel}
                    </span>
                    <span className="pane-label current" title="Editable: your live working file">
                      Current
                    </span>
                  </>
                ) : (
                  <>
                    <span className="pane-label before" title="Read-only: the file at the previous point">
                      🔒 Previous point
                    </span>
                    <span className="pane-label current" title="Read-only: the file as captured at this breaking point">
                      🔒 This point · {beforeLabel}
                    </span>
                  </>
                )}
              </div>
            )}
            <DiffEditor
              original={left}
              modified={right}
              language={langOf(file)}
              inline={inline}
              editable={vsMode === "current"}
              onCommit={persistWorking}
              hunks={hunks}
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
        <ConfirmModal
          title="Revert folder"
          danger
          suppressId="revertFolder"
          message={
            <>
              Restore everything under <b>{dialog.prefix || "/"}</b> to this breaking point.
            </>
          }
          extra={
            <label className="modal-check">
              <input
                type="checkbox"
                checked={dialog.remove}
                onChange={(e) => setDialog({ ...dialog, remove: e.target.checked })}
              />
              Also delete files that did not exist at this point
            </label>
          }
          confirmLabel="Revert folder"
          onConfirm={() => {
            const { prefix, remove } = dialog;
            setDialog(null);
            runFolder(prefix, remove);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {revertAllId != null && (
        <ConfirmModal
          title="Revert everything to this point"
          danger
          suppressId="revertAll"
          message={
            <>
              Restore the entire folder to this breaking point — modified files are reverted, deleted
              files recreated, and files created since this point are removed. A safety breaking point
              is captured first, so you can undo this.
            </>
          }
          confirmLabel="Revert everything"
          onConfirm={() => {
            const id = revertAllId;
            setRevertAllId(null);
            doRevertAll(id);
          }}
          onCancel={() => setRevertAllId(null)}
        />
      )}
    </>
  );
}

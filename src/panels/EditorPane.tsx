import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import FileView, { type FileHandle } from "../components/FileView";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { basename, langOf } from "../lib/util";
import { api } from "../lib/ipc";
import type { BaseInfo } from "../lib/types";

export interface EditorPaneHandle {
  openFile: (path: string) => void;
  hasTab: (path: string) => boolean;
}

interface Props {
  monitorId: number;
  root: string | null;
  baseInfo: BaseInfo | null;
  latestSnap: number | null;
  /** First file to show when the pane mounts. */
  initialFile: string | null;
  /** Global per-path unsaved set (shared with the primary group) for tab dots. */
  dirtyPaths: Set<string>;
  /** Bumped by the parent on external changes so the pane re-syncs with disk. */
  reloadKey: number;
  onMarkDirty: (path: string, dirty: boolean) => void;
  /** The pane took focus (a click landed inside it) — it becomes the open target. */
  onFocus: () => void;
  /** Last tab closed — the parent tears the pane down. */
  onClose: () => void;
  onCopyText: (text: string, label: string) => void;
  toast: (msg: string, error?: boolean) => void;
  style?: CSSProperties;
}

// The secondary editor group of a split. Self-contained: its own tab strip,
// active file, content/baseline loading, save, and revert-to-branch. The primary
// group (in HistoryView) keeps the timeline diff and branch compare; this pane is
// for viewing/editing a file beside it.
const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { monitorId, root, baseInfo, latestSnap, initialFile, dirtyPaths, reloadKey, onMarkDirty, onFocus, onClose, onCopyText, toast, style },
  ref,
) {
  const [tabs, setTabs] = useState<string[]>(initialFile ? [initialFile] : []);
  const [file, setFile] = useState<string | null>(initialFile);
  const [content, setContent] = useState<string | null>("");
  const [contentFor, setContentFor] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [fileBase, setFileBase] = useState("");
  const [baseFor, setBaseFor] = useState<string | null>(null);
  const [diskSync, setDiskSync] = useState(0);
  const viewRef = useRef<FileHandle | null>(null);
  const repoRoot = baseInfo?.kind === "git" ? baseInfo.repo_root : null;

  const openFile = (path: string) => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setFile(path);
  };
  useImperativeHandle(ref, () => ({
    openFile,
    hasTab: (path: string) => tabs.includes(path),
  }));

  const closeTab = (path: string) => {
    const idx = tabs.indexOf(path);
    const next = tabs.filter((p) => p !== path);
    setTabs(next);
    onMarkDirty(path, false);
    if (file === path) setFile(next[Math.min(idx, next.length - 1)] ?? null);
    if (next.length === 0) onClose();
  };

  // Working-file content (or an external package read straight off disk).
  useEffect(() => {
    if (!file) return;
    let alive = true;
    const load = file.startsWith("/") ? api.readTextFile(file) : api.workingFile(monitorId, file);
    load
      .then((c) => {
        if (!alive) return;
        setContent(c);
        setMissing(false);
        setContentFor(file);
      })
      .catch(() => {
        if (!alive) return;
        setContent(null);
        setMissing(true);
        setContentFor(file);
      });
    return () => {
      alive = false;
    };
  }, [file, monitorId, diskSync, reloadKey]);

  // VCS gutter baseline: the file's git HEAD blob (or the latest breaking point
  // in non-git mode). Unversioned files get no baseline (no stripes).
  useEffect(() => {
    if (!file || file.startsWith("/")) {
      setBaseFor(null);
      return;
    }
    let alive = true;
    (async () => {
      let base: string | null = null;
      let unversioned = false;
      try {
        if (baseInfo?.kind === "git" && baseInfo.repo_root && root) {
          const prefix = baseInfo.repo_root.endsWith("/") ? baseInfo.repo_root : `${baseInfo.repo_root}/`;
          const sub = root === baseInfo.repo_root ? "" : root.startsWith(prefix) ? `${root.slice(prefix.length)}/` : "";
          base = await api.gitFile(baseInfo.repo_root, "HEAD", `${sub}${file}`);
          unversioned = base == null;
        } else if (latestSnap != null) {
          base = await api.fileAt(latestSnap, file);
        }
      } catch {
        base = null;
      }
      if (!alive) return;
      if (unversioned) {
        setBaseFor(null);
        return;
      }
      setFileBase(base ?? "");
      setBaseFor(file);
    })();
    return () => {
      alive = false;
    };
  }, [file, monitorId, root, baseInfo, latestSnap, diskSync, reloadKey]);

  const tabbar =
    tabs.length > 0 ? (
      <div className="tabbar">
        {tabs.map((p) => (
          <div
            key={p}
            className={`tab-item${file === p ? " on" : ""}`}
            title={p}
            onClick={() => setFile(p)}
            onAuxClick={(e) => e.button === 1 && closeTab(p)}
          >
            <FileTypeIcon name={p} />
            <span className="tab-name">{basename(p)}</span>
            {dirtyPaths.has(p) && <span className="tab-dot" title="Unsaved changes" />}
            <button
              className={`tab-x${dirtyPaths.has(p) ? " has-dot" : ""}`}
              title="Close (or middle-click the tab)"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(p);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    ) : null;

  return (
    <div className="col main pane-secondary" style={style} onMouseDown={onFocus}>
      {tabbar}
      {!file ? (
        <div className="empty">
          <div className="glyph">⊟</div>
          <h3>Empty pane</h3>
          <p>Open a file here, or close the split.</p>
        </div>
      ) : (
        <>
          <div className="diff-head">
            <span className="file" title={file}>
              {file}
            </span>
          </div>
          {contentFor !== file ? (
            <div className="editor-shell" />
          ) : missing ? (
            <div className="empty">
              <div className="glyph">🗑️</div>
              <h3>This file no longer exists</h3>
              <p>It was deleted or removed by a branch switch.</p>
            </div>
          ) : content === null ? (
            <div className="empty">
              <div className="glyph">⛔</div>
              <h3>Can't display this file</h3>
              <p>It's binary or could not be read as text.</p>
            </div>
          ) : (
            <FileView
              key={file}
              ref={viewRef}
              content={content}
              language={langOf(file)}
              path={file.startsWith("/") ? file : root && file ? `${root}/${file}` : undefined}
              root={root ?? undefined}
              onCopyText={onCopyText}
              onRevertToBranch={
                repoRoot && !file.startsWith("/")
                  ? async () => {
                      try {
                        await api.gitDiscardFile(repoRoot, file);
                        setDiskSync((n) => n + 1);
                      } catch (e) {
                        toast(String(e), true);
                      }
                    }
                  : undefined
              }
              diffBase={!file.startsWith("/") && baseFor === file ? fileBase : undefined}
              onSave={
                file.startsWith("/")
                  ? undefined
                  : async (v, auto) => {
                      try {
                        await api.writeWorkingFile(monitorId, file, v);
                        setContent(v);
                        if (!auto) toast(`Saved ${basename(file)}`);
                      } catch (e) {
                        toast(String(e), true);
                      }
                    }
              }
              onDirtyChange={file && !file.startsWith("/") ? (d) => onMarkDirty(file, d) : undefined}
              onEnter={() => setDiskSync((n) => n + 1)}
            />
          )}
        </>
      )}
    </div>
  );
});

export default EditorPane;

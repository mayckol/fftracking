import { useCallback, useEffect, useRef, useState } from "react";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import RefPicker from "../components/RefPicker";
import { api, WORKDIR } from "../lib/ipc";
import { useShortcut } from "../lib/shortcuts";
import { isConfirmSuppressed } from "../lib/confirmPrefs";
import ConfirmModal from "../components/ConfirmModal";
import type { GitFileChange, HunkInfo, MergeState, RefList, WorkingStatus } from "../lib/types";
import { basename, langOf } from "../lib/util";
import ChangedTree from "./ChangedTree";
import ConflictsDialog from "./ConflictsDialog";
import { openMergeWindow } from "../lib/mergeWindow";
import { usePlugins } from "../lib/plugins/registry";
import { pollWhileVisible } from "../lib/poll";

type GitMode = "commit" | "compare";

const GLYPH = { added: "A", modified: "M", deleted: "D" } as const;

interface Props {
  initialRepo: string | null;
  toast: (msg: string, error?: boolean) => void;
  /** Open the file in the editor (Files tab). Path is repo-relative. */
  onOpenFile?: (path: string) => void;
  /** Set by the status-bar git icon: pop the conflicts list once merge loads. */
  conflictsIntent?: boolean;
  onConflictsHandled?: () => void;
  /** Bumped when a standalone merge window resolves a file: reload merge state. */
  reloadReq?: number;
}

export default function GitView({
  initialRepo,
  toast,
  onOpenFile,
  conflictsIntent,
  onConflictsHandled,
  reloadReq,
}: Props) {
  usePlugins();
  const [repo, setRepo] = useState<string | null>(initialRepo);
  const [mode, setMode] = useState<GitMode>("commit");
  const [refs, setRefs] = useState<RefList | null>(null);
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState(WORKDIR);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [status, setStatus] = useState<WorkingStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [merge, setMerge] = useState<MergeState | null>(null);
  const [showConflicts, setShowConflicts] = useState(false);
  const [collapsed, setCollapsed] = useState({ conflicts: false, staged: false, changes: false });
  const [inline, setInline] = useState(false);
  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const diffApi = useRef<DiffHandle>(null);
  const statusReq = useRef(0);
  // Set when ↑/↓ crossed a file boundary; the load effect then lands on the new
  // file's last ("prev") / first ("next") change.
  const crossFocus = useRef<"first" | "last" | null>(null);

  const loadStatus = useCallback(async (path: string): Promise<WorkingStatus | null> => {
    // Monotonic token: the 3s poll must not clobber a fresher status fetched
    // right after a stage/unstage/commit.
    const req = ++statusReq.current;
    try {
      const s = await api.gitStatus(path);
      if (req === statusReq.current) setStatus(s);
      return s;
    } catch {
      if (req === statusReq.current) setStatus(null);
      return null;
    }
  }, []);

  // Drop a selection once its file no longer differs (e.g. an edit/revert made
  // it match HEAD), so we never leave an empty diff highlighting no list row.
  const dropFileIfClean = (s: WorkingStatus | null) => {
    setFile((cur) =>
      cur && s && !s.staged.some((f) => f.path === cur) && !s.unstaged.some((f) => f.path === cur)
        ? null
        : cur,
    );
  };

  const loadRepo = useCallback(
    async (path: string) => {
      try {
        const r = await api.gitListRefs(path);
        setRefs(r);
        setRepo(path);
        setMerge(await api.gitMergeState(path));
        await loadStatus(path);
      } catch (e) {
        toast(String(e), true);
      }
    },
    [toast, loadStatus],
  );

  useEffect(() => {
    if (initialRepo) loadRepo(initialRepo);
  }, [initialRepo, loadRepo]);

  // Status-bar git icon asked to show the conflicts list: open it once merge
  // state has loaded (it may still be null right after mount), then clear intent.
  useEffect(() => {
    if (!conflictsIntent || !merge) return;
    if (merge.files.length > 0) setShowConflicts(true);
    onConflictsHandled?.();
  }, [conflictsIntent, merge, onConflictsHandled]);

  const reloadMerge = useCallback(async (): Promise<MergeState> => {
    const ms = await api.gitMergeState(repo!);
    setMerge(ms);
    if (repo) loadStatus(repo);
    return ms;
  }, [repo, loadStatus]);

  // A standalone merge window resolved a file: re-read merge state so the list drops it.
  useEffect(() => {
    if (!reloadReq || !repo) return;
    reloadMerge();
  }, [reloadReq, repo, reloadMerge]);

  // Keep the working-tree status AND merge state fresh while staging, so a merge
  // started in the integrated terminal surfaces its conflicts section here.
  useEffect(() => {
    if (!repo || mode !== "commit") return;
    return pollWhileVisible(() => reloadMerge().catch(() => {}), 3000);
  }, [repo, mode, reloadMerge]);

  async function compare() {
    if (!repo) return;
    try {
      const c = await api.gitChangedFiles(repo, from, to);
      setChanges(c);
      setFile(c[0]?.path ?? null);
    } catch (e) {
      toast(String(e), true);
    }
  }

  // Shared diff loader. In commit mode from/to are pinned to HEAD → working tree.
  useEffect(() => {
    if (!repo || !file) {
      setLeft("");
      setRight("");
      return;
    }
    let alive = true;
    (async () => {
      const l = (await api.gitFile(repo, from, file)) ?? "";
      const r = (await api.gitFile(repo, to, file)) ?? "";
      const hk = await api.gitFileHunks(repo, from, to, file);
      if (alive) {
        setLeft(l);
        setRight(r);
        setHunks(hk);
      }
    })();
    return () => {
      alive = false;
    };
  }, [repo, file, from, to]);

  // Only fires on cross-file ↑/↓ (crossFocus set) — a plain file click keeps
  // its top-of-file position, matching the prior behaviour.
  useEffect(() => {
    const which = crossFocus.current;
    if (!file || !which) return;
    crossFocus.current = null;
    const t = window.setTimeout(
      () => (which === "last" ? diffApi.current?.focusLast() : diffApi.current?.focusFirst()),
      120,
    );
    return () => window.clearTimeout(t);
  }, [file]);

  // The changed-file list as ordered on screen, so ↑/↓ spill into the adjacent
  // file. Conflicts open the resolver (not the diff), so they're excluded.
  function orderedPaths(): string[] {
    if (mode === "compare") return changes.map((c) => c.path);
    return [...(status?.staged ?? []), ...(status?.unstaged ?? [])].map((f) => f.path);
  }

  function navDiff(dir: "next" | "prev") {
    if (diffApi.current?.navigate(dir) !== "boundary") return;
    const paths = orderedPaths();
    const i = paths.indexOf(file ?? "");
    const j = dir === "next" ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= paths.length) return;
    crossFocus.current = dir === "next" ? "first" : "last";
    if (mode === "commit") openWorkingFile(paths[j]);
    else {
      setFile(paths[j]);
    }
  }

  function switchMode(m: GitMode) {
    setMode(m);
    setFile(null);
    if (m === "commit") {
      setFrom("HEAD");
      setTo(WORKDIR);
      if (repo) loadStatus(repo);
    }
  }

  function openWorkingFile(path: string) {
    if (from !== "HEAD") setFrom("HEAD");
    if (to !== WORKDIR) setTo(WORKDIR);
    setFile(path);
  }

  async function stage(paths: string[]) {
    if (!repo || paths.length === 0) return;
    try {
      await api.gitStage(repo, paths);
      await loadStatus(repo);
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function unstage(paths: string[]) {
    if (!repo || paths.length === 0) return;
    try {
      await api.gitUnstage(repo, paths);
      await loadStatus(repo);
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function doCommit() {
    if (!repo) return;
    try {
      const oid = await api.gitCommit(repo, commitMsg);
      toast(`Committed ${oid} on ${status?.branch ?? "HEAD"}`);
      setCommitMsg("");
      setFile(null);
      await loadStatus(repo);
      setRefs(await api.gitListRefs(repo));
      // A commit can finish an in-progress merge → its conflicts are now cleared.
      setMerge(await api.gitMergeState(repo));
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function persistWorking(value: string) {
    if (!repo || !file) return;
    try {
      await api.gitWriteWorking(repo, file, value);
      if (to === WORKDIR) setRight(value);
      setHunks(await api.gitFileHunks(repo, from, to, file));
      if (mode === "commit") dropFileIfClean(await loadStatus(repo));
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function discardFile(path: string) {
    if (!repo) return;
    try {
      await api.gitDiscardFile(repo, path);
      toast(`Discarded changes in ${basename(path)}`);
      dropFileIfClean(await loadStatus(repo));
      if (file === path) setFile(null);
    } catch (e) {
      toast(String(e), true);
    }
  }

  const editable = to === WORKDIR;
  useShortcut("diff.next", () => navDiff("next"), !!file);
  useShortcut("diff.prev", () => navDiff("prev"), !!file);
  useShortcut("diff.nextChange", () => navDiff("next"), !!file);
  useShortcut("diff.prevChange", () => navDiff("prev"), !!file);
  useShortcut("diff.layout", () => setInline((v) => !v), !!file);
  useShortcut("diff.revertBlock", () => diffApi.current?.revertCurrent(), !!file && editable);
  useShortcut("diff.undo", () => diffApi.current?.undo(), !!file && editable);
  useShortcut("diff.redo", () => diffApi.current?.redo(), !!file && editable);

  const stagedCount = status?.staged.length ?? 0;
  const conflictCount = merge?.files.length ?? 0;
  type Section = "conflicts" | "staged" | "changes";
  const toggle = (k: Section) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  // Collapsible root header for a commit-view section (Conflicts / Staged / Changes).
  const sectionHead = (key: Section, label: string, count: number, action?: { label: string; onClick: () => void }) => (
    <div className="stage-head" onClick={() => toggle(key)}>
      <span className="sh-chev">{collapsed[key] ? "▸" : "▾"}</span>
      <span className={key === "conflicts" ? "sh-conflict" : undefined}>{label}</span>
      <span className="changecount">{count}</span>
      {action && count > 0 && (
        <button
          className="linklike"
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );

  const conflictRow = (c: { path: string }) => (
    <div
      key={"c:" + c.path}
      className="frow conflict-row"
      onClick={() => merge && repo && openMergeWindow({ repo, path: c.path, ours: merge.ours_label, theirs: merge.theirs_label })}
      title={`${c.path} — open the 3-way merge`}
    >
      <span className="stat conflicted">!</span>
      <span className="fname">{c.path}</span>
    </div>
  );

  const fileRow = (f: GitFileChange, staged: boolean) => (
    <div
      key={(staged ? "s:" : "u:") + f.path}
      className={`frow${file === f.path ? " on" : ""}`}
      onClick={() => openWorkingFile(f.path)}
      onDoubleClick={() => onOpenFile?.(f.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, path: f.path });
      }}
      title={f.path}
    >
      <span className={`stat ${f.status}`}>{GLYPH[f.status]}</span>
      <span className="fname">{f.path}</span>
      <button
        className="stage-btn"
        title={staged ? "Unstage" : "Stage"}
        onClick={(e) => {
          e.stopPropagation();
          (staged ? unstage : stage)([f.path]);
        }}
      >
        {staged ? "−" : "+"}
      </button>
    </div>
  );

  return (
    <>
      <div className="col">
        <div className="git-bar">
          <div className="git-mode">
            {(["commit", "compare"] as GitMode[]).map((m) => (
              <button key={m} className={`seg${mode === m ? " on" : ""}`} onClick={() => switchMode(m)}>
                {m}
              </button>
            ))}
          </div>
          {repo && (
            <span className="repo-name" title={repo}>
              {basename(repo)}
            </span>
          )}
          {repo && mode === "compare" && (
            <>
              <RefPicker refs={refs} value={from} onChange={setFrom} includeWorkdir={false} />
              <span className="arrow">→</span>
              <RefPicker refs={refs} value={to} onChange={setTo} includeWorkdir />
              <button className="tbtn" onClick={compare}>
                Compare
              </button>
            </>
          )}
          {repo && mode === "commit" && status && (
            <span className="repo-name" title="Current branch">
              ⎇ {status.branch}
            </span>
          )}
        </div>

        {merge && merge.files.length > 0 && (
          <div className="conflict-banner" title="In-progress merge">
            Merging <b>{merge.theirs_label}</b> into <b>{merge.ours_label}</b>
          </div>
        )}

        {mode === "commit" ? (
          <>
            <div className="col-scroll">
              {conflictCount > 0 && (
                <>
                  {sectionHead("conflicts", "Conflicts", conflictCount, {
                    label: "Resolve all…",
                    onClick: () => setShowConflicts(true),
                  })}
                  {!collapsed.conflicts && merge!.files.map((c) => conflictRow(c))}
                </>
              )}

              {sectionHead("staged", "Staged", stagedCount, {
                label: "Unstage all",
                onClick: () => unstage(status!.staged.map((s) => s.path)),
              })}
              {!collapsed.staged &&
                (stagedCount === 0 ? (
                  <div className="stage-empty">Nothing staged</div>
                ) : (
                  status?.staged.map((f) => fileRow(f, true))
                ))}

              {sectionHead("changes", "Changes", status?.unstaged.length ?? 0, {
                label: "Stage all",
                onClick: () => stage(status!.unstaged.map((s) => s.path)),
              })}
              {!collapsed.changes &&
                ((status?.unstaged.length ?? 0) === 0 ? (
                  <div className="stage-empty">No changes</div>
                ) : (
                  status?.unstaged.map((f) => fileRow(f, false))
                ))}
            </div>

            <div className="commit-box">
              <textarea
                value={commitMsg}
                placeholder={`Commit message${status ? ` (${status.branch})` : ""}`}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit();
                }}
              />
              <button
                className="tbtn primary commit-btn"
                disabled={stagedCount === 0 || !commitMsg.trim()}
                onClick={doCommit}
              >
                Commit {stagedCount} file{stagedCount === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="col-head">
              <h2>Changed Files</h2>
              <span className="changecount">{changes.length}</span>
            </div>
            <div className="col-scroll">
              <ChangedTree
                changes={changes}
                selected={file}
                onSelect={(p) => setFile(p)}
                onOpenFile={onOpenFile}
              />
            </div>
          </>
        )}
      </div>

      {file ? (
        <div className="col main">
          <div className="diff-head">
            <span className="file" title={file}>
              {file}
            </span>
            <button className="tbtn" title="Previous change" onClick={() => navDiff("prev")}>
              ↑
            </button>
            <button className="tbtn" title="Next change" onClick={() => navDiff("next")}>
              ↓
            </button>
            {editable && (
              <>
                <button className="tbtn" title="Undo (in this diff)" onClick={() => diffApi.current?.undo()}>
                  ↶
                </button>
                <button className="tbtn" title="Redo (in this diff)" onClick={() => diffApi.current?.redo()}>
                  ↷
                </button>
              </>
            )}
            <span className="vs">
              {from} → {to === WORKDIR ? "working tree" : to}
            </span>
            {mode === "compare" && to !== WORKDIR && (
              <button
                className="tbtn"
                title={`Compare ${from} against your working tree so you can apply its blocks into it`}
                onClick={() => setTo(WORKDIR)}
              >
                ↧ Apply against working tree
              </button>
            )}
            {hunks.length > 0 && (
              <span
                className="changecount"
                title={
                  to === WORKDIR
                    ? `Click ⟲ in the gutter to apply the ${from} version of a block to the working tree; ⌘Z / Ctrl+Z to undo`
                    : "Both sides are read-only revisions. Switch the right side to your working tree (↧) to apply blocks."
                }
              >
                {hunks.length} change{hunks.length === 1 ? "" : "s"}
                {to === WORKDIR ? ` · ⟲ applies ${from} → working · ⌘Z undo` : " · read-only (↧ to apply)"}
              </span>
            )}
            {mode === "commit" && file && (
              <div className="diff-actions">
                {status?.staged.some((s) => s.path === file) ? (
                  <button className="tbtn" onClick={() => unstage([file])}>
                    − Unstage
                  </button>
                ) : (
                  <button className="tbtn" onClick={() => stage([file])}>
                    + Stage
                  </button>
                )}
              </div>
            )}
            {onOpenFile && (
              <button
                className="tbtn"
                style={{ marginLeft: mode === "commit" ? undefined : "auto" }}
                onClick={() => onOpenFile(file)}
                title="Open this file in the editor (Files tab)"
              >
                ↗ file
              </button>
            )}
            <button
              className="tbtn"
              style={{ marginLeft: onOpenFile ? undefined : mode === "commit" ? undefined : "auto" }}
              onClick={() => setInline(!inline)}
              title="Diff layout: side-by-side or inline"
            >
              {inline ? "≣ inline" : "⇆ split"}
            </button>
          </div>
          <DiffEditor
            original={left}
            modified={right}
            language={langOf(file)}
            inline={inline}
            editable={to === WORKDIR}
            onCommit={persistWorking}
            hunks={hunks}
            ref={diffApi}
          />
        </div>
      ) : (
        <div className="col main">
          <div className="empty">
            <div className="glyph">⎇</div>
            <h3>{repo ? (mode === "commit" ? "Stage & commit" : "Compare revisions") : "Open a git repository"}</h3>
            <p>
              {!repo
                ? "Choose a local repo to stage, commit, diff branches/commits — and resolve merge conflicts."
                : mode === "commit"
                  ? "Stage files with +, review the diff, write a message, and commit. Conflicts from an in-progress merge show up on top."
                  : "Pick two refs above and hit Compare."}
            </p>
          </div>
        </div>
      )}

      {showConflicts && repo && merge && (
        <ConflictsDialog
          repoPath={repo}
          state={merge}
          toast={toast}
          onReload={reloadMerge}
          onClose={() => setShowConflicts(false)}
          onMerge={(p) =>
            openMergeWindow({ repo, path: p, ours: merge.ours_label, theirs: merge.theirs_label })
          }
        />
      )}

      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                const p = menu.path;
                setMenu(null);
                if (isConfirmSuppressed("discardFile")) discardFile(p);
                else setDiscardPath(p);
              }}
            >
              Discard changes (restore to HEAD)
            </button>
            <button
              onClick={() => {
                openWorkingFile(menu.path);
                setMenu(null);
              }}
            >
              Open diff
            </button>
          </div>
        </>
      )}

      {discardPath && (
        <ConfirmModal
          title="Discard changes"
          danger
          suppressId="discardFile"
          message={
            <>
              Restore <b>{discardPath}</b> to its committed (HEAD) version, discarding your working-tree
              changes? An untracked file is removed. This is <b>git checkout</b> — it cannot be undone
              from here.
            </>
          }
          confirmLabel="Discard changes"
          onConfirm={() => {
            const p = discardPath;
            setDiscardPath(null);
            discardFile(p);
          }}
          onCancel={() => setDiscardPath(null)}
        />
      )}
    </>
  );
}

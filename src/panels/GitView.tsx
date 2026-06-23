import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import RefPicker from "../components/RefPicker";
import { api, WORKDIR } from "../lib/ipc";
import { useShortcut } from "../lib/shortcuts";
import { isConfirmSuppressed } from "../lib/confirmPrefs";
import ConfirmModal from "../components/ConfirmModal";
import type { GitFileChange, HunkInfo, MergeState, RefList, WorkingStatus } from "../lib/types";
import { basename, langOf } from "../lib/util";
import { buildFileTree, flattenTree } from "../lib/filetree";
import ChangedTree from "./ChangedTree";
import CommitTree from "./CommitTree";
import ConflictsDialog from "./ConflictsDialog";
import { openMergeWindow } from "../lib/mergeWindow";
import { usePlugins } from "../lib/plugins/registry";
import { pollWhileVisible } from "../lib/poll";

type GitMode = "commit" | "compare";

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
  /** False while the view is mounted but hidden (another tab is showing). Gates
   *  the diff keyboard shortcuts so the hidden view doesn't clobber the active
   *  one's handlers in the shared shortcut registry. */
  active?: boolean;
}

export default function GitView({
  initialRepo,
  toast,
  onOpenFile,
  conflictsIntent,
  onConflictsHandled,
  reloadReq,
  active = true,
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
  const [collapsed, setCollapsed] = useState({ conflicts: false, staged: false, changes: false, untracked: false });
  const [inline, setInline] = useState(false);
  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; paths: string[]; isDir: boolean; label: string } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{ paths: string[]; label: string; isDir: boolean } | null>(null);
  const [query, setQuery] = useState("");
  // Bumped on any external-change signal (window refocus, backend watcher/poll
  // event); pulls the open diff's blobs again since from/to/file don't change
  // across an external `git checkout` but the underlying content does.
  const [reloadKey, setReloadKey] = useState(0);
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
  const dropFileIfClean = useCallback((s: WorkingStatus | null) => {
    setFile((cur) =>
      cur && s && !s.staged.some((f) => f.path === cur) && !s.unstaged.some((f) => f.path === cur)
        ? null
        : cur,
    );
  }, []);

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

  const loadCompare = useCallback(
    async (reset: boolean) => {
      if (!repo) return;
      try {
        const c = await api.gitChangedFiles(repo, from, to);
        setChanges(c);
        // Keep the open file across a background refresh; only re-seed when the
        // user explicitly hit Compare or the prior selection no longer differs.
        setFile((cur) => (reset || !cur || !c.some((x) => x.path === cur) ? c[0]?.path ?? null : cur));
      } catch (e) {
        if (reset) toast(String(e), true);
      }
    },
    [repo, from, to, toast],
  );

  const compare = () => loadCompare(true);

  // Comparing against the live working tree (to === WORKDIR) is inherently live:
  // refresh it on the same merge/edit signals commit mode uses so a merge done
  // elsewhere (terminal, conflict resolve) reflects without re-hitting Compare.
  useEffect(() => {
    if (!repo || mode !== "compare" || to !== WORKDIR) return;
    loadCompare(false);
    return pollWhileVisible(() => loadCompare(false), 3000);
  }, [repo, mode, to, reloadReq, loadCompare]);

  // External git activity (a terminal checkout, an AI agent, another tool)
  // leaves from/to/file unchanged, so the per-dependency effects above never
  // re-run. Pull everything an outside change can move: refs/branch, the working
  // status or compare list, merge state, and the open diff's blobs (reloadKey).
  const refreshExternal = useCallback(async () => {
    if (!repo) return;
    try {
      setRefs(await api.gitListRefs(repo));
    } catch {
      // repo vanished mid-op; the loaders below surface the failure
    }
    if (mode === "commit") {
      dropFileIfClean(await loadStatus(repo));
      api.gitMergeState(repo).then(setMerge).catch(() => {});
    } else {
      loadCompare(false).catch(() => {});
    }
    setReloadKey((k) => k + 1);
  }, [repo, mode, loadStatus, loadCompare, dropFileIfClean]);

  // The external op usually lands while the window is unfocused (user is in
  // their terminal); refresh on return. Mirrors HistoryView's focus resync.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      refreshExternal();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshExternal]);

  // Backend filesystem signals — the same pair HistoryView consumes — for when
  // the change lands while the window stays focused (split layout, integrated
  // terminal). Coalesced: both events can fire for one change. Not filtered by
  // monitorId (GitView tracks a repo path, not a monitor); a spurious refresh
  // just re-reads this repo's git state, which is cheap.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refreshExternal(), 200);
    };
    const uns = [listen("monitor-changed", schedule), listen("tree-changed", schedule)];
    return () => {
      clearTimeout(timer);
      uns.forEach((un) => un.then((f) => f()));
    };
  }, [refreshExternal]);

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
  }, [repo, file, from, to, reloadKey]);

  // Opening any file jumps the diff to its first change (and highlights it) so
  // the user lands on what changed, not the top of the file. Cross-file ↑/↓ sets
  // the direction; a plain click defaults to the first change.
  useEffect(() => {
    if (!file) return;
    const which = crossFocus.current ?? "first";
    crossFocus.current = null;
    const t = window.setTimeout(
      () => (which === "last" ? diffApi.current?.focusLast() : diffApi.current?.focusFirst()),
      120,
    );
    return () => window.clearTimeout(t);
  }, [file]);

  // Auto-open the first changed file when nothing is selected yet, so opening the
  // Git view lands straight on the first file's first change instead of an empty
  // pane. Only fires while no file is picked, so it never fights a user click.
  useEffect(() => {
    if (!active || file) return;
    const first = orderedPaths()[0];
    if (!first) return;
    if (mode === "commit") openWorkingFile(first);
    else setFile(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, file, mode, status, changes, merge, query]);

  // The changed-file list as ordered on screen, so ↑/↓ spill into the adjacent
  // file. Conflicts open the resolver (not the diff), so they're excluded.
  function orderedPaths(): string[] {
    const flat = (items: GitFileChange[]) => flattenTree(buildFileTree(items)).map((f) => f.path);
    if (mode === "compare") return flat(compareChanges);
    return [...flat(stagedList), ...flat(trackedChanges), ...flat(untrackedChanges)];
  }

  function navDiff(dir: "next" | "prev") {
    if (diffApi.current?.navigate(dir) !== "boundary") return;
    const paths = orderedPaths();
    const i = paths.indexOf(file ?? "");
    if (i < 0 || paths.length === 0) return;
    // Cycle through the list: down on the last row → first, up on the first → last.
    const j = (i + (dir === "next" ? 1 : -1) + paths.length) % paths.length;
    if (j === i) return;
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

  async function discardFiles(paths: string[]) {
    if (!repo || paths.length === 0) return;
    try {
      for (const p of paths) await api.gitDiscardFile(repo, p);
      toast(
        paths.length === 1
          ? `Discarded changes in ${basename(paths[0])}`
          : `Discarded changes in ${paths.length} files`,
      );
      dropFileIfClean(await loadStatus(repo));
      if (file && paths.includes(file)) setFile(null);
    } catch (e) {
      toast(String(e), true);
    }
  }

  const editable = to === WORKDIR;
  useShortcut("diff.next", () => navDiff("next"), active && !!file);
  useShortcut("diff.prev", () => navDiff("prev"), active && !!file);
  useShortcut("diff.nextChange", () => navDiff("next"), active && !!file);
  useShortcut("diff.prevChange", () => navDiff("prev"), active && !!file);
  useShortcut("diff.layout", () => setInline((v) => !v), active && !!file);
  useShortcut("diff.revertBlock", () => diffApi.current?.revertCurrent(), active && !!file && editable);
  useShortcut("diff.applyChange", () => diffApi.current?.revertCurrent(), active && !!file && editable);
  useShortcut("diff.revertChange", () => diffApi.current?.revertCurrent(), active && !!file && editable);
  useShortcut("diff.undo", () => diffApi.current?.undo(), active && !!file && editable);
  useShortcut("diff.redo", () => diffApi.current?.redo(), active && !!file && editable);

  const q = query.trim().toLowerCase();
  const matchQ = (f: { path: string }) => !q || f.path.toLowerCase().includes(q);
  const stagedList = (status?.staged ?? []).filter(matchQ);
  const conflictFiles = (merge?.files ?? []).filter(matchQ);
  const stagedCount = stagedList.length;
  const conflictCount = conflictFiles.length;
  // Untracked (git WT_NEW) surfaces in `unstaged` as status "added"; tracked
  // edits/deletes are the rest. Split so new files get their own section.
  const trackedChanges = (status?.unstaged.filter((f) => f.status !== "added") ?? []).filter(matchQ);
  const untrackedChanges = (status?.unstaged.filter((f) => f.status === "added") ?? []).filter(matchQ);
  const compareChanges = changes.filter(matchQ);
  type Section = "conflicts" | "staged" | "changes" | "untracked";
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

        {repo && (
          <div className="git-search">
            <span className="git-search-icon">⌕</span>
            <input
              className="git-search-input"
              placeholder="Filter changes by name or path…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="git-search-clear" title="Clear filter" onClick={() => setQuery("")}>
                ×
              </button>
            )}
          </div>
        )}

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
                  {!collapsed.conflicts && conflictFiles.map((c) => conflictRow(c))}
                </>
              )}

              {sectionHead("staged", "Staged", stagedCount, {
                label: "Unstage all",
                onClick: () => unstage(stagedList.map((s) => s.path)),
              })}
              {!collapsed.staged &&
                (stagedCount === 0 ? (
                  <div className="stage-empty">{q ? "No staged matches" : "Nothing staged"}</div>
                ) : (
                  <CommitTree
                    changes={stagedList}
                    staged
                    selected={file}
                    onSelect={openWorkingFile}
                    onOpenFile={onOpenFile}
                    onStage={stage}
                    onUnstage={unstage}
                    onContextMenu={setMenu}
                  />
                ))}

              {sectionHead("changes", "Changes", trackedChanges.length, {
                label: "Stage all",
                onClick: () => stage(trackedChanges.map((s) => s.path)),
              })}
              {!collapsed.changes &&
                (trackedChanges.length === 0 ? (
                  <div className="stage-empty">No changes</div>
                ) : (
                  <CommitTree
                    changes={trackedChanges}
                    staged={false}
                    selected={file}
                    onSelect={openWorkingFile}
                    onOpenFile={onOpenFile}
                    onStage={stage}
                    onUnstage={unstage}
                    onContextMenu={setMenu}
                  />
                ))}

              {untrackedChanges.length > 0 && (
                <>
                  {sectionHead("untracked", "Unversioned", untrackedChanges.length, {
                    label: "Stage all",
                    onClick: () => stage(untrackedChanges.map((s) => s.path)),
                  })}
                  {!collapsed.untracked && (
                    <CommitTree
                      changes={untrackedChanges}
                      staged={false}
                      selected={file}
                      onSelect={openWorkingFile}
                      onOpenFile={onOpenFile}
                      onStage={stage}
                      onUnstage={unstage}
                      onContextMenu={setMenu}
                    />
                  )}
                </>
              )}
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
              <span className="changecount">{compareChanges.length}</span>
            </div>
            <div className="col-scroll">
              <ChangedTree
                changes={compareChanges}
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
            <span className="dh-meta">
              <span className="vs">
                {from} → {to === WORKDIR ? "working tree" : to}
              </span>
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
            </span>
            <div className="dh-tools">
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
              {mode === "compare" && to !== WORKDIR && (
                <button
                  className="tbtn"
                  title={`Compare ${from} against your working tree so you can apply its blocks into it`}
                  onClick={() => setTo(WORKDIR)}
                >
                  ↧ Apply against working tree
                </button>
              )}
              {mode === "commit" && file && (
                status?.staged.some((s) => s.path === file) ? (
                  <button className="tbtn" onClick={() => unstage([file])}>
                    − Unstage
                  </button>
                ) : (
                  <button className="tbtn" onClick={() => stage([file])}>
                    + Stage
                  </button>
                )
              )}
              {onOpenFile && (
                <button
                  className="tbtn"
                  onClick={() => onOpenFile(file)}
                  title="Open this file in the editor (Files tab)"
                >
                  ↗ file
                </button>
              )}
              <button
                className="tbtn"
                onClick={() => setInline(!inline)}
                title="Diff layout: side-by-side or inline"
              >
                {inline ? "≣ inline" : "⇆ split"}
              </button>
            </div>
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
                const t = { paths: menu.paths, label: menu.label, isDir: menu.isDir };
                setMenu(null);
                if (isConfirmSuppressed("discardFile")) discardFiles(t.paths);
                else setDiscardTarget(t);
              }}
            >
              {menu.isDir
                ? `Discard all changes in ${menu.label}/ (restore to HEAD)`
                : "Discard changes (restore to HEAD)"}
            </button>
            {!menu.isDir && (
              <button
                onClick={() => {
                  openWorkingFile(menu.paths[0]);
                  setMenu(null);
                }}
              >
                Open diff
              </button>
            )}
          </div>
        </>
      )}

      {discardTarget && (
        <ConfirmModal
          title="Discard changes"
          danger
          suppressId="discardFile"
          message={
            discardTarget.isDir ? (
              <>
                Restore the {discardTarget.paths.length} changed file
                {discardTarget.paths.length === 1 ? "" : "s"} under <b>{discardTarget.label}/</b> to their
                committed (HEAD) version, discarding your working-tree changes? Untracked files are removed.
                This is <b>git checkout</b> — it cannot be undone from here.
              </>
            ) : (
              <>
                Restore <b>{discardTarget.paths[0]}</b> to its committed (HEAD) version, discarding your
                working-tree changes? An untracked file is removed. This is <b>git checkout</b> — it cannot
                be undone from here.
              </>
            )
          }
          confirmLabel="Discard changes"
          onConfirm={() => {
            const t = discardTarget;
            setDiscardTarget(null);
            discardFiles(t.paths);
          }}
          onCancel={() => setDiscardTarget(null)}
        />
      )}
    </>
  );
}

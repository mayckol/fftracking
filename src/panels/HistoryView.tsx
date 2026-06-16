import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import { api } from "../lib/ipc";
import type { BaseInfo, ChangeSummary, FileChange, HunkInfo, SnapshotRow } from "../lib/types";
import { basename, dayLabel, dirname, fmtTime, langOf } from "../lib/util";
import { useShortcut } from "../lib/shortcuts";
import { isConfirmSuppressed } from "../lib/confirmPrefs";
import { getPrefs } from "../lib/uiPrefs";
import { getErrorPaths, setNavHandler, subscribeDiagnostics } from "../lib/lsp";
import { recordRecent } from "../lib/fuzzy";
import ConfirmModal from "../components/ConfirmModal";
import ChangedTree from "./ChangedTree";
import ProjectTree, { type ProjectTreeHandle } from "./ProjectTree";
import FileView, { type FileHandle } from "../components/FileView";
import Splitter from "../components/Splitter";
import Timeline from "./Timeline";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { usePlugins } from "../lib/plugins/registry";

interface Props {
  monitorId: number;
  root: string | null;
  historyMode?: boolean;
  onModeChange?: (history: boolean) => void;
  /** Open request from the search palette (n bumps on every accept). Files
   *  open in a tab; dirs are revealed in the project tree instead. */
  openReq?: { monitorId: number; path: string; line?: number; col?: number; kind?: "file" | "dir"; n: number } | null;
  /** Tree context menu → open the search palette scoped to a folder. */
  onSearchInFolder?: (prefix: string, replace: boolean) => void;
  /** Run / Terminal / Debug dock, docked under the editor (keeps sidebars tall). */
  bottom?: ReactNode;
  toast: (msg: string, error?: boolean) => void;
}

type TabKind = "file" | "diff";
interface EditorTab {
  path: string;
  kind: TabKind;
}

export default function HistoryView({
  monitorId,
  root,
  historyMode,
  onModeChange,
  openReq,
  onSearchInFolder,
  bottom,
  toast,
}: Props) {
  // Re-render when a plugin toggles so langOf re-derives the editor language
  // and open files switch tokenizer live (e.g. .env on dotenv enable/disable).
  usePlugins();
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
  // The project tree is always visible; history (timeline + changed files) is an
  // optional panel. What the main pane shows follows where the selection came
  // from: a tree file → plain view, a changed file → diff.
  const [showHistory, setShowHistory] = useState(historyMode ?? false);
  const [openKind, setOpenKind] = useState<"file" | "diff">("file");
  // Open editor tabs (path + which view). `file`/`openKind` point at the active
  // one; max count and overflow behaviour come from UI prefs.
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  // Paths with unsaved edits → render a dot in the tab. Reported by FileView.
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const markDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  // Full on-disk file list for the project tree (all files, not just changes).
  const [files, setFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<string | null>("");
  // Which file `fileContent` belongs to — the editor must never mount with a
  // previous file's text (its undo stack would record the swap as an edit).
  const [contentFor, setContentFor] = useState<string | null>(null);
  // Baseline for the editor's VCS-style gutter stripes: git HEAD when the
  // monitor sits in a repo, else the latest breaking point. "" = no baseline
  // version exists (new file → everything reads as added).
  const [baseInfo, setBaseInfo] = useState<BaseInfo | null>(null);
  const [fileBase, setFileBase] = useState<string>("");
  const [baseFor, setBaseFor] = useState<string | null>(null);
  // Files differing from the same baseline, to tint their tree rows green.
  const [treeChanged, setTreeChanged] = useState<Set<string>>(new Set());
  // Drag-resizable side-pane width (px).
  const [sideW, setSideW] = useState(340);
  // Relative paths (under `root`) that currently have LSP errors, for the tree.
  const [errFiles, setErrFiles] = useState<Set<string>>(new Set());
  // Pending cross-file go-to-definition jump (relative path + 1-based pos).
  const [pendingGoto, setPendingGoto] = useState<{ path: string; line: number; col: number } | null>(null);

  // Back/Forward navigation history (JetBrains-style; mouse buttons 4/5). Refs,
  // not state — it drives setFile/setPendingGoto rather than rendering itself.
  const fileViewRef = useRef<FileHandle | null>(null);
  const projectTreeRef = useRef<ProjectTreeHandle | null>(null);
  const pendingTreeFocus = useRef(false);
  // Dir path waiting to be revealed once the tree mounts (history → files flip).
  const pendingTreeReveal = useRef<string | null>(null);
  const navStack = useRef<{ path: string; line: number; col: number }[]>([]);
  const navIdx = useRef(-1);
  const fileRef = useRef<string | null>(file);
  fileRef.current = file;
  const openKindRef = useRef(openKind);
  openKindRef.current = openKind;

  const lastFileKey = (id: number) => `ff.lastFile.${id}`;

  const liveLoc = () => {
    const p = fileViewRef.current?.getPosition();
    return { path: fileRef.current ?? "", line: p?.line ?? 1, col: p?.col ?? 1 };
  };

  // Record a destination, refreshing the current spot first and truncating any
  // forward history (a new branch invalidates redo).
  const recordNav = (dest: { path: string; line: number; col: number }) => {
    const s = navStack.current.slice(0, navIdx.current + 1);
    if (s.length && fileRef.current) s[s.length - 1] = liveLoc();
    const top = s[s.length - 1];
    if (!top || top.path !== dest.path) s.push(dest);
    navStack.current = s;
    navIdx.current = s.length - 1;
  };

  const navGo = (delta: number) => {
    const ni = navIdx.current + delta;
    if (ni < 0 || ni >= navStack.current.length) return;
    if (navIdx.current >= 0 && navStack.current[navIdx.current]) navStack.current[navIdx.current] = liveLoc();
    navIdx.current = ni;
    const e = navStack.current[ni];
    if (e.path === fileRef.current && openKindRef.current === "file") {
      fileViewRef.current?.reveal(e.line, e.col);
    } else {
      setOpenKind("file");
      setFile(e.path);
      setPendingGoto({ path: e.path, line: e.line, col: e.col });
      setTabs((prev) =>
        prev.some((t) => t.path === e.path && t.kind === "file") ? prev : [...prev, { path: e.path, kind: "file" }],
      );
    }
  };
  const navGoRef = useRef(navGo);
  navGoRef.current = navGo;

  // In-file caret jump (click): append a distinct nav point so Back walks every
  // visited line, not just file switches. Dedupe repeat clicks on the same line.
  const pushCursor = (line: number, col: number) => {
    if (!fileRef.current) return;
    const s = navStack.current.slice(0, navIdx.current + 1);
    const top = s[s.length - 1];
    if (top && top.path === fileRef.current && top.line === line) {
      navStack.current = s;
      navIdx.current = s.length - 1;
      return;
    }
    s.push({ path: fileRef.current, line, col });
    navStack.current = s;
    navIdx.current = s.length - 1;
  };

  const activate = (t: EditorTab) => {
    setFile(t.path);
    setOpenKind(t.kind);
    // Remember the last opened project file (not external packages) so the
    // monitor reopens it next time.
    if (t.kind === "file" && !t.path.startsWith("/")) {
      localStorage.setItem(lastFileKey(monitorId), t.path);
      recordRecent(monitorId, t.path);
    }
  };

  const openTab = (path: string, kind: TabKind) => {
    if (tabs.some((t) => t.path === path && t.kind === kind)) {
      activate({ path, kind });
      return;
    }
    const { maxTabs, tabOverflow } = getPrefs();
    if (tabs.length >= maxTabs) {
      if (tabOverflow === "block") {
        toast(`Tab limit reached (${maxTabs}). Close a tab to open another.`, true);
        return;
      }
      // FIFO: drop the oldest tab(s) to make room for the new one.
      setTabs([...tabs.slice(tabs.length - maxTabs + 1), { path, kind }]);
    } else {
      setTabs([...tabs, { path, kind }]);
    }
    activate({ path, kind });
  };

  const openFile = (path: string) => {
    recordNav({ path, line: 1, col: 1 });
    openTab(path, "file");
  };
  const openChange = (path: string) => openTab(path, "diff");

  const closeTab = (t: EditorTab) => {
    const idx = tabs.findIndex((x) => x.path === t.path && x.kind === t.kind);
    if (idx < 0) return;
    const next = tabs.filter((_, i) => i !== idx);
    setTabs(next);
    if (!next.some((x) => x.path === t.path)) markDirty(t.path, false);
    if (file === t.path && openKind === t.kind) {
      const nb = next[Math.min(idx, next.length - 1)];
      if (nb) activate(nb);
      else {
        setFile(null);
        localStorage.removeItem(lastFileKey(monitorId));
      }
    }
  };

  // Drop any tabs whose path matches (e.g. when the file is ignored/removed).
  const closeTabsWhere = (match: (path: string) => boolean) => {
    const next = tabs.filter((t) => !match(t.path));
    if (next.length === tabs.length) return;
    setTabs(next);
    setDirtyPaths((prev) => {
      const keep = new Set(next.map((t) => t.path));
      const out = new Set([...prev].filter((p) => keep.has(p)));
      return out.size === prev.size ? prev : out;
    });
    if (file && match(file)) {
      if (next[0]) activate(next[0]);
      else setFile(null);
    }
  };
  // What the changed-files list and diff compare the selected point against:
  // "point" = the changes this breaking point introduced (vs the git branch or
  // the previous point — the same base the timeline badges use), "current" =
  // drift between the point and the live working tree (JetBrains Local History).
  const [vsMode, setVsMode] = useState<"point" | "current">("point");
  // When set, the history view is scoped to one file/folder: the timeline shows
  // only points that changed this path, and the changed-files list is filtered
  // to it. Cleared by the banner's ✕ or a monitor switch.
  const [historyFilter, setHistoryFilter] = useState<string | null>(null);
  const [scopedSummaries, setScopedSummaries] = useState<Record<number, ChangeSummary>>({});
  const diffApi = useRef<DiffHandle>(null);
  const summariesKey = useRef("");
  const diffReq = useRef(0);
  // Set when ↑/↓ crossed a file boundary, so the load effect lands on the new
  // file's last ("prev") / first ("next") change instead of always the first.
  const crossFocus = useRef<"first" | "last" | null>(null);
  // window.prompt/confirm don't work in the Tauri webview — use a custom modal.
  const [dialog, setDialog] = useState<
    | { kind: "label"; id: number; value: string }
    | { kind: "folder"; prefix: string; remove: boolean }
    | { kind: "delete"; path: string; isDir: boolean }
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
    setHistoryFilter(null);
    summariesKey.current = "";
    // Reopen the last file viewed for this monitor, if any. Reset nav history.
    const last = localStorage.getItem(lastFileKey(monitorId));
    if (last) {
      setFile(last);
      setOpenKind("file");
      setTabs([{ path: last, kind: "file" }]);
      navStack.current = [{ path: last, line: 1, col: 1 }];
      navIdx.current = 0;
    } else {
      setFile(null);
      setTabs([]);
      navStack.current = [];
      navIdx.current = -1;
    }
    loadSnaps();
  }, [monitorId, loadSnaps]);

  // Top-nav Files/History tab drives the panel mode.
  useEffect(() => {
    if (historyMode !== undefined) setShowHistory(historyMode);
  }, [historyMode]);

  // Deferred tree focus/reveal after flipping out of history mode (tree just mounted).
  useEffect(() => {
    if (showHistory) return;
    if (pendingTreeFocus.current) {
      pendingTreeFocus.current = false;
      projectTreeRef.current?.focusInTree();
    }
    if (pendingTreeReveal.current) {
      const path = pendingTreeReveal.current;
      pendingTreeReveal.current = null;
      projectTreeRef.current?.revealDir(path);
    }
  }, [showHistory]);

  // Mirror LSP error files (absolute) into root-relative paths for the tree.
  useEffect(() => {
    const recompute = () => {
      const out = new Set<string>();
      if (root) {
        const prefix = root.endsWith("/") ? root : `${root}/`;
        for (const abs of getErrorPaths()) {
          if (abs.startsWith(prefix)) out.add(abs.slice(prefix.length));
        }
      }
      setErrFiles(out);
    };
    recompute();
    return subscribeDiagnostics(recompute);
  }, [root]);

  // Cross-file ⌘-click: open the target file as a tab and queue the jump.
  const navRef = useRef<(abs: string, line: number, col: number) => void>(() => {});
  navRef.current = (abs, line, col) => {
    if (!root) return;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    // Inside the workspace → tab path is relative; external packages (stdlib,
    // module cache) keep their absolute path and open read-only.
    const target = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    recordNav({ path: target, line, col });
    if (target === fileRef.current && openKindRef.current === "file") {
      fileViewRef.current?.reveal(line, col);
    } else {
      openTab(target, "file");
      setPendingGoto({ path: target, line, col });
    }
  };
  useEffect(() => setNavHandler((a, l, c) => navRef.current(a, l, c)), []);

  // Search-palette opens. The monitorId guard keeps a remount (folder switch)
  // from replaying a request that targeted another monitor.
  const lastOpenReq = useRef(0);
  useEffect(() => {
    if (!openReq || openReq.monitorId !== monitorId || openReq.n === lastOpenReq.current) return;
    lastOpenReq.current = openReq.n;
    const { path, line, col, kind } = openReq;
    if (kind === "dir") {
      if (showHistory) {
        pendingTreeReveal.current = path;
        setShowHistory(false);
        onModeChange?.(false);
      } else {
        projectTreeRef.current?.revealDir(path);
      }
      return;
    }
    recordNav({ path, line: line ?? 1, col: col ?? 1 });
    openTab(path, "file");
    if (line != null) setPendingGoto({ path, line, col: col ?? 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq, monitorId]);

  // Mouse thumb buttons: 3 = back (button 4), 4 = forward (button 5).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        navGoRef.current(-1);
      } else if (e.button === 4) {
        e.preventDefault();
        navGoRef.current(1);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  // New breaking points (event/interval) land in the DB while watching — poll
  // so the timeline reflects them live without re-selecting the folder.
  useEffect(() => {
    const t = window.setInterval(() => loadSnaps(), 3000);
    return () => window.clearInterval(t);
  }, [loadSnaps]);

  // Scoped history: which points touched the filtered path (+ scoped badges).
  // Re-runs only when the point set actually changes, not on every poll.
  const snapsKey = snaps.map((s) => s.id).join(",");
  useEffect(() => {
    if (!historyFilter) {
      setScopedSummaries({});
      return;
    }
    let alive = true;
    api
      .snapshotSummariesUnder(monitorId, historyFilter)
      .then((rows) => alive && setScopedSummaries(Object.fromEntries(rows.map((s) => [s.id, s]))))
      .catch(() => alive && setScopedSummaries({}));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFilter, monitorId, snapsKey, reload]);

  // When scoping, jump selection to the newest point that touched the path if
  // the current one falls outside the filtered set.
  useEffect(() => {
    if (!historyFilter) return;
    setSnap((cur) => {
      if (cur && scopedSummaries[cur]) return cur;
      const first = snaps.find((s) => scopedSummaries[s.id]);
      return first?.id ?? null;
    });
  }, [scopedSummaries, historyFilter, snaps]);

  useEffect(() => {
    let alive = true;
    api
      .monitorFiles(monitorId)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [monitorId, reload]);

  // Project mode: plain view of the live working file (null = binary or
  // unreadable, so we show a placeholder). External packages (absolute path,
  // outside the monitor) are read straight off disk.
  useEffect(() => {
    if (openKind !== "file" || !file) return;
    let alive = true;
    const load = file.startsWith("/") ? api.readTextFile(file) : api.workingFile(monitorId, file);
    load
      .then((c) => {
        if (alive) {
          setFileContent(c);
          setContentFor(file);
        }
      })
      .catch(() => {
        if (alive) {
          setFileContent(null);
          setContentFor(file);
        }
      });
    return () => {
      alive = false;
    };
  }, [openKind, file, monitorId]);

  useEffect(() => {
    let alive = true;
    api
      .monitorBaseInfo(monitorId)
      .then((b) => alive && setBaseInfo(b))
      .catch(() => alive && setBaseInfo(null));
    return () => {
      alive = false;
    };
  }, [monitorId]);

  // Gutter-stripe baseline for the open working file. Re-fetched when the
  // point set changes: in snapshot mode the latest point IS the baseline, and
  // in git mode a save is a natural moment to pick up a new HEAD.
  const latestSnap = snaps[0]?.id ?? null;
  useEffect(() => {
    if (openKind !== "file" || !file || file.startsWith("/")) {
      setBaseFor(null);
      return;
    }
    let alive = true;
    (async () => {
      let base: string | null = null;
      // git mode: a file with no HEAD blob is unversioned (gitignored or
      // untracked). Git has no baseline for it, so show no VCS gutter stripes
      // (JetBrains-style) instead of diffing the whole file against "" and
      // painting every line as an addition.
      let unversioned = false;
      try {
        if (baseInfo?.kind === "git" && baseInfo.repo_root && root) {
          // The monitor root may be a subfolder of the repo — git paths are
          // relative to the repo root.
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
  }, [openKind, file, monitorId, root, baseInfo, latestSnap, reload]);

  // Changed-files set for the tree tint, refreshed on the same cadence as the
  // timeline poll. Git mode: status vs HEAD (paths are repo-relative — map to
  // monitor-relative). Fallback: drift vs the latest breaking point.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        let paths: string[] = [];
        if (baseInfo?.kind === "git" && baseInfo.repo_root && root) {
          const st = await api.gitStatus(baseInfo.repo_root);
          const prefix = baseInfo.repo_root.endsWith("/") ? baseInfo.repo_root : `${baseInfo.repo_root}/`;
          const sub = root === baseInfo.repo_root ? "" : root.startsWith(prefix) ? `${root.slice(prefix.length)}/` : "";
          paths = [...st.staged, ...st.unstaged]
            .map((c) => c.path)
            .filter((p) => p.startsWith(sub))
            .map((p) => p.slice(sub.length));
        } else if (latestSnap != null) {
          paths = (await api.snapshotWorkingChanges(monitorId, latestSnap)).map((c) => c.path);
        }
        if (alive) setTreeChanged(new Set(paths));
      } catch {
        if (alive) setTreeChanged(new Set());
      }
    };
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [monitorId, root, baseInfo, latestSnap, reload]);

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
      // Don't force-open the first change — opening is explicit (click) and
      // goes through the tab layer. Stale tabs are pruned on monitor change.
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
    if (snap == null || !file || file.startsWith("/")) {
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
    const which = crossFocus.current ?? "first";
    crossFocus.current = null;
    const t = window.setTimeout(
      () => (which === "last" ? diffApi.current?.focusLast() : diffApi.current?.focusFirst()),
      180,
    );
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

  async function runDelete(path: string, isDir: boolean) {
    setDialog(null);
    try {
      await api.deletePath(monitorId, path);
      // Close the open file if it (or its parent folder) was deleted.
      if (file && (file === path || (isDir && file.startsWith(`${path}/`)))) setFile(null);
      setReload((n) => n + 1);
      toast(`Moved ${isDir ? "folder" : "file"} to trash`);
    } catch (e) {
      toast(String(e), true);
    }
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
      closeTabsWhere((p) => p === path || (isDir && p.startsWith(`${path}/`)));
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

  // ↑/↓ walk changes within the file; at the first/last change they spill over
  // into the previous/next changed file (landing on its last/first change).
  function navDiff(dir: "next" | "prev") {
    if (diffApi.current?.navigate(dir) !== "boundary") return;
    const i = changes.findIndex((c) => c.path === file);
    const j = dir === "next" ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= changes.length) return;
    crossFocus.current = dir === "next" ? "first" : "last";
    setFile(changes[j].path);
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

  // Diff-only bindings: gate to the diff view so they don't steal ⌘Z (undo) and
  // friends from the plain editable file view (which shares the .editor-wrap
  // class the diff scope-check targets).
  const inDiff = openKind === "diff" && !!file;
  useShortcut("diff.next", () => navDiff("next"), inDiff);
  useShortcut("diff.prev", () => navDiff("prev"), inDiff);
  useShortcut("diff.layout", () => setInline((v) => !v), inDiff);
  useShortcut("diff.revertBlock", () => diffApi.current?.revertCurrent(), inDiff);
  useShortcut("diff.undo", () => diffApi.current?.undo(), inDiff);
  useShortcut("diff.redo", () => diffApi.current?.redo(), inDiff);
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
  useShortcut(
    "file.focusInTree",
    () => {
      // In history mode the tree isn't mounted; flip to the files view and run
      // the focus once it renders (see the pendingTreeFocus effect).
      if (showHistory) {
        pendingTreeFocus.current = true;
        setShowHistory(false);
        onModeChange?.(false);
      } else {
        projectTreeRef.current?.focusInTree();
      }
    },
    !!file,
  );
  useShortcut("nav.nextPoint", () => gotoPoint(1));
  useShortcut("nav.prevPoint", () => gotoPoint(-1));
  useShortcut("nav.back", () => navGoRef.current(-1));
  useShortcut("nav.forward", () => navGoRef.current(1));

  const underFilter = (p: string) =>
    !historyFilter || p === historyFilter || p.startsWith(`${historyFilter}/`);
  const displaySnaps = historyFilter ? snaps.filter((s) => scopedSummaries[s.id]) : snaps;
  const displaySummaries = historyFilter ? scopedSummaries : summaries;
  const displayChanges = historyFilter ? changes.filter((c) => underFilter(c.path)) : changes;

  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const c of displayChanges) counts[c.status]++;
  const sel = snaps.find((s) => s.id === snap);
  const beforeLabel = sel ? `${dayLabel(sel.day_bucket)}, ${fmtTime(sel.ts)}` : "Before";

  return (
    <>
      <div className="hv">
        <div className="hv-side" style={{ width: sideW }}>
          <div className="col-head">
            <h2>{showHistory ? "History" : "Files"}</h2>
            {!showHistory && <span className="changecount">{files.length}</span>}
            <button
              className={`vs-tag${showHistory ? " on" : ""}`}
              style={{ marginLeft: "auto" }}
              title={showHistory ? "Show the project files tree" : "Show history (timeline & changed files)"}
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                onModeChange?.(next);
              }}
            >
              {showHistory ? "files" : "history"}
            </button>
          </div>

          <div className="hv-side-body">
            {showHistory ? (
              <div className="hv-history">
                {historyFilter && (
                  <div className="hv-filter" title={historyFilter}>
                    <span className="hv-filter-path">⏱ {historyFilter}</span>
                    <button className="hv-filter-clear" title="Show full history" onClick={() => setHistoryFilter(null)}>
                      ✕
                    </button>
                  </div>
                )}
                <div className="hv-hpane">
                  <div className="col-head">
                    <h2>Breaking Points</h2>
                    <span className="base-tag" title="Change badges show what each point changed vs the one before it">
                      ↔ previous point
                    </span>
                  </div>
                  <div className="col-scroll">
                    {historyFilter && displaySnaps.length === 0 ? (
                      <div className="empty" style={{ padding: "16px 12px" }}>
                        <p>No breaking points changed this path.</p>
                      </div>
                    ) : (
                      <Timeline
                        snapshots={displaySnaps}
                        summaries={displaySummaries}
                        selected={snap}
                        onSelect={setSnap}
                        onDelete={deleteSnap}
                        onLabel={labelSnap}
                        onRevertAll={askRevertAll}
                      />
                    )}
                  </div>
                </div>
                <div className="hv-hpane">
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
                    {displayChanges.length > 0 ? (
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
                      changes={displayChanges}
                      selected={openKind === "diff" ? file : null}
                      onSelect={openChange}
                      onRevertFile={revertPath}
                      onRevertFolder={revertFolderPath}
                      onIgnoreFile={(p) => ignorePath(p, false)}
                      onIgnoreFolder={(p) => ignorePath(p, true)}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="col-scroll" style={{ flex: 1 }}>
                <ProjectTree
                  ref={projectTreeRef}
                  files={files}
                  selected={openKind === "file" ? file : null}
                  errorFiles={errFiles}
                  changedFiles={treeChanged}
                  rootPath={root}
                  onSelect={openFile}
                  onOpen={(p) => api.openPath(monitorId, p).catch((e) => toast(String(e), true))}
                  onReveal={(p) => api.revealPath(monitorId, p).catch((e) => toast(String(e), true))}
                  onShowHistory={(p) => {
                    setHistoryFilter(p);
                    setShowHistory(true);
                    onModeChange?.(true);
                  }}
                  onCopyPath={copyToClipboard}
                  onIgnoreFile={(p) => ignorePath(p, false)}
                  onIgnoreFolder={(p) => ignorePath(p, true)}
                  onFindInFolder={onSearchInFolder && ((p) => onSearchInFolder(p, false))}
                  onReplaceInFolder={onSearchInFolder && ((p) => onSearchInFolder(p, true))}
                  onDelete={(p, isDir) => setDialog({ kind: "delete", path: p, isDir })}
                />
              </div>
            )}
          </div>
        </div>

        <Splitter dir="x" onDelta={(d) => setSideW((w) => Math.max(220, Math.min(760, w + d)))} />

      <div className="col main">
        {tabs.length > 0 && (
          <div className="tabbar">
            {tabs.map((t) => {
              const on = file === t.path && openKind === t.kind;
              return (
                <div
                  key={`${t.kind}:${t.path}`}
                  className={`tab-item${on ? " on" : ""}`}
                  title={t.path}
                  onClick={() => {
                    if (t.kind === "file") recordNav({ path: t.path, line: 1, col: 1 });
                    activate(t);
                  }}
                  onAuxClick={(e) => e.button === 1 && closeTab(t)}
                >
                  <FileTypeIcon name={t.path} />
                  <span className="tab-name">{basename(t.path)}</span>
                  {t.kind === "diff" && (
                    <span className="tab-kind" title="Diff view">
                      ⇆
                    </span>
                  )}
                  {t.kind === "file" && dirtyPaths.has(t.path) && (
                    <span className="tab-dot" title="Unsaved changes" aria-label="Unsaved changes" />
                  )}
                  <button
                    className={`tab-x${t.kind === "file" && dirtyPaths.has(t.path) ? " has-dot" : ""}`}
                    title="Close (or middle-click the tab)"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {openKind === "file" ? (
          file ? (
            <>
              <div className="diff-head">
                <span className="file" title={file}>
                  {file}
                </span>
              </div>
              {contentFor !== file ? (
                // Still loading this file — mounting the editor with the
                // previous file's content would poison its undo stack.
                <div className="editor-shell" />
              ) : fileContent === null ? (
                <div className="empty">
                  <div className="glyph">⛔</div>
                  <h3>Can't display this file</h3>
                  <p>It's binary or could not be read as text.</p>
                </div>
              ) : (
                <FileView
                  key={file}
                  ref={fileViewRef}
                  onCursorClick={pushCursor}
                  content={fileContent}
                  language={langOf(file)}
                  path={file.startsWith("/") ? file : root && file ? `${root}/${file}` : undefined}
                  root={root ?? undefined}
                  readOnly={file.startsWith("/")}
                  onCopyText={copyToClipboard}
                  diffBase={!file.startsWith("/") && baseFor === file ? fileBase : undefined}
                  gotoPos={pendingGoto && pendingGoto.path === file ? { line: pendingGoto.line, col: pendingGoto.col } : undefined}
                  onSave={
                    file.startsWith("/")
                      ? undefined
                      : async (v, auto) => {
                          if (!file) return;
                          try {
                            await api.writeWorkingFile(monitorId, file, v);
                            setFileContent(v);
                            await loadSnaps(snap ?? undefined);
                            if (!auto) toast(`Saved ${basename(file)}`);
                          } catch (e) {
                            toast(String(e), true);
                          }
                        }
                  }
                  onDirtyChange={file && !file.startsWith("/") ? (d) => markDirty(file, d) : undefined}
                />
              )}
            </>
          ) : (
            <div className="empty">
              <div className="glyph">📄</div>
              <h3>Open a file</h3>
              <p>Pick a file from the project tree to view it.</p>
            </div>
          )
        ) : file ? (
          <>
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
        ) : snaps.length === 0 ? (
          <div className="empty">
            <img className="hero-logo" src="/logo.png" alt="fftracking" />
            <h3>No breaking points</h3>
            <p>Edit a file in this folder and a breaking point appears here automatically. You can also snapshot manually from the top bar. Pick a file from the tree to read it now.</p>
          </div>
        ) : (
          <div className="empty">
            <div className="glyph">⟷</div>
            <h3>Select a change</h3>
            <p>Pick a breaking point, then a changed file to see the diff.</p>
          </div>
        )}
        {bottom}
      </div>
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

      {dialog?.kind === "delete" && (
        <ConfirmModal
          title={`Delete ${dialog.isDir ? "folder" : "file"}`}
          danger
          message={
            <>
              Move <b>{dialog.path}</b>
              {dialog.isDir ? " and everything inside it" : ""} to the trash? You can restore it from
              your system trash.
            </>
          }
          confirmLabel="Move to trash"
          onConfirm={() => runDelete(dialog.path, dialog.isDir)}
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

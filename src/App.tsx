import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { api } from "./lib/ipc";
import { comboFor, formatCombo, installShortcuts, useShortcut } from "./lib/shortcuts";
import { useUIPrefs } from "./lib/uiPrefs";
import { isConfirmSuppressed } from "./lib/confirmPrefs";
import { getSelectedText } from "./lib/selection";
import { foldAtCursor, resetZoom, unfoldAtCursor, zoomIn, zoomOut } from "./lib/editorActions";
import { getScopeDir } from "./lib/searchScope";
import { pollWhileVisible } from "./lib/poll";
import { checkUpdate, runUpdate, type UpdateState } from "./lib/update";
import { setTerminalOpener } from "./lib/runner";
import { getRunSnapshot, resetRun, setRunOpener, subscribeRun } from "./lib/run";
import { restartLsp, shutdownLsp } from "./lib/lsp";
import {
  dbgResume,
  dbgStepInto,
  dbgStepOut,
  dbgStepOver,
  getDebugSnapshot,
  setDebugOpener,
  stopDebug,
  subscribeDebug,
} from "./lib/debug";
import ConfirmModal from "./components/ConfirmModal";
import ExecMenu from "./components/ExecMenu";
import KeymapStyleModal from "./components/KeymapStyleModal";
import SearchPalette, { type PaletteMode } from "./components/SearchPalette";
import SettingsPalette from "./components/SettingsPalette";
import ShortcutsModal from "./components/ShortcutsModal";
import RefPicker from "./components/RefPicker";
import ProjectPicker from "./components/ProjectPicker";
import type { MonitorRow, RefList, ResourceUsage } from "./lib/types";
import GitView from "./panels/GitView";
import HistoryView from "./panels/HistoryView";
import SettingsView from "./panels/SettingsView";
import PluginsView from "./panels/PluginsView";
import StatusBar from "./components/StatusBar";
import TerminalPanel from "./panels/TerminalPanel";
import DebugPanel from "./panels/DebugPanel";
import RunPanel from "./panels/RunPanel";

type Tab = "files" | "history" | "git" | "plugins" | "settings";

// Last project the user had open, restored on the next launch so a multi-project
// setup reopens where they left off (HistoryView then restores that project's
// last file from ff.lastFile.<id>).
const LAST_PROJECT_KEY = "ff.lastProject";

// How long a project's language servers linger after you switch away before they
// are torn down. A quick flip back within the window cancels the teardown, so
// brief detours don't pay a cold gopls/vtsls restart.
const LSP_IDLE_GRACE_MS = 45_000;

export default function App() {
  const [tab, setTab] = useState<Tab>("files");
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [res, setRes] = useState<ResourceUsage | null>(null);
  const [confirmDel, setConfirmDel] = useState<MonitorRow | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Run / Terminal / Debug share the bottom slot — only one shows at a time.
  const [bottom, setBottom] = useState<"run" | "terminal" | "debug" | null>(null);
  const toggleBottom = (b: "run" | "terminal" | "debug") => setBottom((cur) => (cur === b ? null : b));
  const [debugH, setDebugH] = useState(300);
  const [dbgStatus, setDbgStatus] = useState(getDebugSnapshot().status);
  const [runH, setRunH] = useState(300);
  const [runStatus, setRunStatus] = useState(getRunSnapshot().status);
  const [search, setSearch] = useState<PaletteMode | null>(null);
  const [settingsPalette, setSettingsPalette] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Open state of the Run / Debug recent-executions dropdowns.
  const [execMenu, setExecMenu] = useState<"run" | "debug" | null>(null);
  // Settings section to scroll to when routed from the settings palette.
  const [settingsScroll, setSettingsScroll] = useState<string | null>(null);
  // Bumped by ⌘⇧R: tells the palette to open its replace row. Reset on close
  // so a later plain ⌘⇧F doesn't reopen with replace enabled.
  const [replaceReq, setReplaceReq] = useState(0);
  useEffect(() => {
    if (search === null) setReplaceReq(0);
  }, [search]);
  // Open-a-file / reveal-a-folder request from the search palette, routed into HistoryView.
  const [openReq, setOpenReq] = useState<{
    monitorId: number;
    path: string;
    line?: number;
    col?: number;
    kind?: "file" | "dir";
    n: number;
  } | null>(null);
  const [termH, setTermH] = useState(280);
  // Manual show/hide of the project file tree, toggled from the bottom status bar.
  const [treeHidden, setTreeHidden] = useState(false);
  // Unresolved merge conflicts in the selected repo: marks the status-bar git icon
  // danger; `conflictsIntent` asks GitView to pop the conflicts list on next mount.
  const [mergeConflicts, setMergeConflicts] = useState(0);
  const [conflictsIntent, setConflictsIntent] = useState(false);
  // Bumped when a standalone merge window resolves a file, so GitView re-reads
  // merge state and the conflicts list drops the resolved entry.
  const [mergeReload, setMergeReload] = useState(0);
  const toastTimer = useRef<number>();
  const prefs = useUIPrefs();
  // Shown in the titlebar — read from tauri.conf.json (the version of record,
  // which CI keeps in sync with the release tag) instead of a hardcoded string.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  // Newer release available? Checked on launch (then every 6h). The titlebar pill
  // re-runs the installer in a terminal.
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    const run = () => checkUpdate().then((u) => setUpdate(u && u.available ? u : null)).catch(() => {});
    run();
    const t = window.setInterval(run, 6 * 60 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
  // Current branch + repo refs for the titlebar branch switcher (RefPicker).
  // repoRoot is null for non-git monitors, which hides the switcher.
  const [branch, setBranch] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [branchRefs, setBranchRefs] = useState<RefList | null>(null);
  useEffect(() => {
    if (selected == null) {
      setBranch(null);
      setRepoRoot(null);
      setBranchRefs(null);
      return;
    }
    let alive = true;
    api
      .monitorBaseInfo(selected)
      .then(async (b) => {
        if (!alive) return;
        setBranch(b.branch);
        const root = b.kind === "git" ? b.repo_root : null;
        setRepoRoot(root);
        setBranchRefs(root ? await api.gitListRefs(root).catch(() => null) : null);
      })
      .catch(() => {
        if (!alive) return;
        setBranch(null);
        setRepoRoot(null);
        setBranchRefs(null);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  async function switchBranch(ref: string) {
    if (!repoRoot || ref === branch) return;
    try {
      await api.gitCheckoutBranch(repoRoot, ref);
      // Re-read so the label reflects the real HEAD (a commit/tag detaches it).
      const info = await api.monitorBaseInfo(selected!);
      setBranch(info.branch);
      setBranchRefs(await api.gitListRefs(repoRoot).catch(() => branchRefs));
      notify(`Switched to ${ref}`);
    } catch (e) {
      notify(String(e), true);
    }
  }

  // Suppress the webview's native right-click menu (the "Reload" popup);
  // our own context menus call preventDefault themselves where needed.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  useEffect(() => {
    const tick = () => api.resourceUsage().then(setRes).catch(() => {});
    tick();
    return pollWhileVisible(tick, 2000);
  }, []);

  const notify = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const loadMonitors = useCallback(async () => {
    const rows = await api.listMonitors();
    setMonitors(rows);
    // A project queued by the CLI launcher (`fftrack <path>`) wins over the
    // remembered/first one. Claimed once, then the backend returns null.
    const pending = await api.takePendingOpen().catch(() => null);
    setSelected((cur) => {
      if (pending && rows.some((r) => r.id === pending)) return pending;
      if (cur != null) return cur;
      const saved = Number(localStorage.getItem(LAST_PROJECT_KEY));
      if (saved && rows.some((r) => r.id === saved)) return saved;
      return rows[0]?.id ?? null;
    });
  }, []);

  // `fftrack <path>` against an already-running instance: open that project.
  useEffect(() => {
    const un = listen<number>("open-project", (e) => {
      setSelected(e.payload);
      loadMonitors();
    });
    return () => void un.then((f) => f());
  }, [loadMonitors]);

  // Remember the active project across restarts.
  useEffect(() => {
    if (selected != null) localStorage.setItem(LAST_PROJECT_KEY, String(selected));
  }, [selected]);

  // A run belongs to the project it was started in — switching projects stops it
  // and clears the panel so the new project never shows the old one's output.
  useEffect(() => {
    void resetRun();
  }, [selected]);

  // Exclusive monitoring: the selected project is the only one captured.
  // Whenever the selection changes (picker, add, delete fallback, restore on
  // launch) the backend stops every other monitor and starts this one, so just
  // one project is ever tracked at a time. The list refresh repaints the live
  // dots to match.
  useEffect(() => {
    if (selected == null) return;
    api
      .setActiveMonitor(selected)
      .then(loadMonitors)
      .catch((e) => notify(String(e), true));
  }, [selected, loadMonitors, notify]);

  useEffect(() => {
    loadMonitors();
    return pollWhileVisible(loadMonitors, 4000); // reflect daemon-added folders
  }, [loadMonitors]);

  async function addFolder() {
    const path = await api.pickFolder();
    if (!path) return;
    try {
      const settings = await api.getSettings();
      const id = await api.addMonitor(path, settings.default_interval_secs);
      await loadMonitors();
      setSelected(id);
      notify("Now tracking " + path);
    } catch (e) {
      notify(String(e), true);
    }
  }

  async function deleteFolder(id: number) {
    setConfirmDel(null);
    setDeletingId(id);
    try {
      await api.removeMonitor(id);
      const rows = await api.listMonitors();
      setMonitors(rows);
      setSelected((cur) => (cur === id ? rows[0]?.id ?? null : cur));
      notify("Folder & history deleted");
    } catch (e) {
      notify(String(e), true);
    } finally {
      setDeletingId(null);
    }
  }

  function askDelete(m: MonitorRow) {
    if (deletingId != null) return;
    if (isConfirmSuppressed("deleteFolder")) deleteFolder(m.id);
    else setConfirmDel(m);
  }

  async function snapshotNow() {
    if (selected == null) return;
    try {
      const id = await api.snapshotNow(selected);
      notify(id ? "Breaking point captured" : "No changes since last point");
    } catch (e) {
      notify(String(e), true);
    }
  }

  const selectedMonitor = monitors.find((m) => m.id === selected) ?? null;

  const repoPath = selectedMonitor?.root_path ?? null;
  useEffect(() => {
    if (!repoPath) {
      setMergeConflicts(0);
      return;
    }
    const tick = async () => {
      try {
        const ms = await api.gitMergeState(repoPath);
        setMergeConflicts(ms.files.length);
      } catch {
        setMergeConflicts(0);
      }
    };
    tick();
    return pollWhileVisible(tick, 3000);
  }, [repoPath]);

  // Idle-teardown: free a project's language servers once it stops being the
  // active one. gopls/vtsls start per project root and otherwise live for the
  // app's lifetime, so cycling across N projects stacks N server processes (each
  // loading its own module graph). On switch-away the previous root's servers are
  // scheduled for shutdown after a grace delay; returning within the window
  // cancels it.
  const prevRootRef = useRef<string | null>(null);
  const lspIdleTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const active = repoPath;
    const timers = lspIdleTimers.current;
    if (active) {
      const pending = timers.get(active);
      if (pending !== undefined) {
        clearTimeout(pending);
        timers.delete(active);
      }
    }
    const prev = prevRootRef.current;
    prevRootRef.current = active;
    if (prev && prev !== active && !timers.has(prev)) {
      const timer = window.setTimeout(() => {
        timers.delete(prev);
        if (prevRootRef.current !== prev) void shutdownLsp(prev);
      }, LSP_IDLE_GRACE_MS);
      timers.set(prev, timer);
    }
  }, [repoPath]);
  useEffect(() => {
    const timers = lspIdleTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // A standalone merge window finished a file: refresh the count immediately and
  // tell GitView to reload so its conflicts list stays in sync.
  useEffect(() => {
    const un = listen("merge-resolved", () => {
      if (repoPath) api.gitMergeState(repoPath).then((ms) => setMergeConflicts(ms.files.length)).catch(() => {});
      setMergeReload((n) => n + 1);
    });
    return () => {
      un.then((f) => f());
    };
  }, [repoPath]);

  useEffect(installShortcuts, []);
  // Test-runner clicks need the terminal panel visible before they can type.
  useEffect(() => {
    setTerminalOpener(() => setBottom("terminal"));
    return () => setTerminalOpener(null);
  }, []);
  // Starting a debug session (gutter "Debug …") reveals the debug panel.
  useEffect(() => {
    setDebugOpener(() => setBottom("debug"));
    return () => setDebugOpener(null);
  }, []);
  useEffect(() => subscribeDebug(() => setDbgStatus(getDebugSnapshot().status)), []);
  const dbgActive = dbgStatus === "starting" || dbgStatus === "running" || dbgStatus === "paused";
  // Running a test / program (gutter "Run …" or ^⇧R) reveals the run panel.
  useEffect(() => {
    setRunOpener(() => setBottom("run"));
    return () => setRunOpener(null);
  }, []);
  useEffect(() => subscribeRun(() => setRunStatus(getRunSnapshot().status)), []);
  const runActive = runStatus === "running";
  useShortcut("debug.panel", () => toggleBottom("debug"));
  useShortcut("debug.stepOver", dbgStepOver, dbgStatus === "paused");
  useShortcut("debug.stepInto", dbgStepInto, dbgStatus === "paused");
  useShortcut("debug.stepOut", dbgStepOut, dbgStatus === "paused");
  useShortcut("debug.resume", dbgResume, dbgStatus === "paused");
  useShortcut("debug.stop", () => stopDebug(), dbgActive);
  useShortcut("nav.files", () => setTab("files"));
  useShortcut("nav.history", () => setTab("history"));
  useShortcut("nav.git", () => setTab("git"));
  useShortcut("nav.settings", () => setTab("settings"));
  useShortcut("nav.plugins", () => setTab("plugins"));
  const inWorkspace = tab === "files" || tab === "history";
  // Toggle works from any tab: inside the workspace it just shows/hides the
  // tree; from git/plugins/settings it jumps back to the files workspace with
  // the tree shown, so the control is always a one-click route to the tree.
  const toggleTree = () => {
    if (inWorkspace) {
      setTreeHidden((v) => !v);
    } else {
      setTab("files");
      setTreeHidden(false);
    }
  };
  useShortcut("nav.toggleTree", toggleTree);
  useShortcut("capture.snapshot", snapshotNow, inWorkspace && selected != null);
  useShortcut("terminal.toggle", () => toggleBottom("terminal"));
  useShortcut("run.toggle", () => toggleBottom("run"));
  useShortcut("settings.palette", () => setSettingsPalette((v) => !v));
  useShortcut("app.quit", () => void api.quitApp());
  // Fold/zoom run on the focused editor. Registered globally (not via Monaco
  // keybindings) so number-row and numpad +/-/− both fire.
  useShortcut("editor.fold", foldAtCursor);
  useShortcut("editor.unfold", unfoldAtCursor);
  useShortcut("editor.zoomIn", zoomIn);
  useShortcut("editor.zoomOut", zoomOut);
  useShortcut("editor.zoomReset", resetZoom);
  // Seeds for the palette, captured at the moment the shortcut fires — query
  // from the editor selection (first line, like VSCode's ⌘⇧F), scope from the
  // last folder clicked in the project tree.
  const [searchSeed, setSearchSeed] = useState("");
  const [searchScope, setSearchScope] = useState<string | null>(null);
  const grabSeed = () => getSelectedText().split("\n")[0].trim().slice(0, 200);

  function openTextSearch(replace: boolean, scope: string | null) {
    setSearchSeed(grabSeed());
    setSearchScope(scope);
    if (replace) {
      setSearch("text");
      setReplaceReq((n) => n + 1);
    } else {
      setSearch((s) => (s === "text" ? null : "text"));
    }
  }

  useShortcut("search.quickOpen", () => setSearch((s) => (s === "files" ? null : "files")), selected != null);
  useShortcut("search.text", () => openTextSearch(false, getScopeDir()), selected != null);
  useShortcut("search.replace", () => openTextSearch(true, getScopeDir()), selected != null);

  function openFromSearch(path: string, line?: number, col?: number) {
    if (selected == null) return;
    if (tab !== "files" && tab !== "history") setTab("files");
    setOpenReq((r) => ({ monitorId: selected, path, line, col, n: (r?.n ?? 0) + 1 }));
  }

  // Folder picked in the palette: highlight it in the project tree (expanding
  // its nested folders) rather than opening the OS file manager.
  function revealFolderFromSearch(path: string) {
    if (selected == null) return;
    if (tab !== "files" && tab !== "history") setTab("files");
    setOpenReq((r) => ({ monitorId: selected, path, kind: "dir" as const, n: (r?.n ?? 0) + 1 }));
  }

  // The Run / Terminal / Debug dock. In the Files view it's rendered inside the
  // editor column so both sidebars (monitors + project tree) keep full height
  // and the dock only spans the editor. Elsewhere it sits full-width at the foot.
  const bottomPanel =
    bottom === "run" ? (
      <RunPanel
        height={runH}
        onResize={(d) => setRunH((h) => Math.max(160, Math.min(window.innerHeight - 140, h - d)))}
        onClose={() => setBottom(null)}
      />
    ) : bottom === "debug" ? (
      <DebugPanel
        root={selectedMonitor?.root_path ?? null}
        height={debugH}
        onResize={(d) => setDebugH((h) => Math.max(160, Math.min(window.innerHeight - 140, h - d)))}
        onClose={() => setBottom(null)}
      />
    ) : bottom === "terminal" ? (
      <TerminalPanel
        cwd={selectedMonitor?.root_path ?? null}
        height={termH}
        onResize={(d) => setTermH((h) => Math.max(120, Math.min(window.innerHeight - 140, h - d)))}
        onClose={() => setBottom(null)}
      />
    ) : null;
  // True while the editor column owns the dock (Files/History view with a folder
  // selected). Otherwise the dock falls back to the full-width foot slot.
  const dockInWorkspace = inWorkspace && selected != null;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="project-id">
          <ProjectPicker
            monitors={monitors}
            selected={selected}
            deletingId={deletingId}
            onSelect={setSelected}
            onRemove={askDelete}
          />
          <button className="tbtn proj-add" onClick={addFolder} title="Track a folder" aria-label="Track a folder">
            <svg
              className="btn-ic"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
          {branch &&
            (repoRoot ? (
              <div className="branch-switch">
                <RefPicker refs={branchRefs} value={branch} onChange={switchBranch} includeWorkdir={false} />
              </div>
            ) : (
              <span className="project-branch">{branch}</span>
            ))}
        </div>
        <div className="spacer" />
        <div className="split-btn">
          <button
            className={`tbtn${bottom === "run" ? " on" : ""}`}
            onClick={() => toggleBottom("run")}
            title={`${bottom === "run" ? "Hide" : "Show"} run panel (${formatCombo(comboFor("run.toggle"))})`}
          >
            <svg className="btn-ic ic-run" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="M4.6 3.3a.6.6 0 0 1 .92-.5l6.8 4.2a.6.6 0 0 1 0 1.02l-6.8 4.2a.6.6 0 0 1-.92-.5z" fill="currentColor" />
            </svg>
            <span>Run</span>
            {runActive && <span className="live-dot" title="Running" />}
          </button>
          <button
            className={`tbtn split-caret${execMenu === "run" ? " on" : ""}`}
            title="Recent runs"
            onClick={() => setExecMenu((m) => (m === "run" ? null : "run"))}
          >
            ▾
          </button>
          {execMenu === "run" && <ExecMenu kind="run" onClose={() => setExecMenu(null)} />}
        </div>
        <div className="split-btn">
          <button
            className={`tbtn${bottom === "debug" ? " on" : ""}`}
            onClick={() => toggleBottom("debug")}
            title={`${bottom === "debug" ? "Hide" : "Show"} debug panel (${formatCombo(comboFor("debug.panel"))})`}
          >
            <svg
              className="btn-ic ic-debug"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6.4 4.4a1.6 1.6 0 0 1 3.2 0" />
              <rect x="5" y="5.4" width="6" height="7" rx="3" />
              <path d="M8 6.2v6M5 8.4H2.9M11 8.4h2.1M5.1 6.2 3.5 5M10.9 6.2 12.5 5M5.1 10.8 3.4 12M10.9 10.8 12.6 12" />
            </svg>
            <span>Debug</span>
            {dbgActive && <span className="live-dot amber" title="Debugging" />}
          </button>
          <button
            className={`tbtn split-caret${execMenu === "debug" ? " on" : ""}`}
            title="Recent debug sessions"
            onClick={() => setExecMenu((m) => (m === "debug" ? null : "debug"))}
          >
            ▾
          </button>
          {execMenu === "debug" && <ExecMenu kind="debug" onClose={() => setExecMenu(null)} />}
        </div>
        {res && (
          <div className="res-meter" title="fftracking CPU and memory usage">
            <span title="CPU">
              <svg className="rm-ic cpu" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
                <rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.2" />
                <path d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14" />
              </svg>
              {res.cpu_percent.toFixed(res.cpu_percent < 10 ? 1 : 0)}%
            </span>
            <span title="Memory">
              <svg className="rm-ic mem" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
                <rect x="1.75" y="4.5" width="12.5" height="7" rx="1.2" />
                <path d="M5 11.5V14M8 11.5V14M11 11.5V14M5 6.75v2.5M8 6.75v2.5M11 6.75v2.5" />
              </svg>
              {(res.mem_bytes / 1048576).toFixed(0)} MB
            </span>
          </div>
        )}
        <div className="brand">
          <span className="dot" />
          fftracking
          {appVersion && <small>v{appVersion}</small>}
          {update && (
            <button
              className="update-pill"
              title={`Update to v${update.latest} (re-runs the installer in a terminal)`}
              onClick={async () => {
                try {
                  await runUpdate();
                  notify("Updater opened in a terminal — reopen fftracking when it finishes");
                } catch (e) {
                  notify(String(e), true);
                }
              }}
            >
              ↑ v{update.latest}
            </button>
          )}
        </div>
      </header>

      {(tab === "files" || tab === "history") && (
        <div className="work" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          {selected != null ? (
            <HistoryView
              key={selected}
              monitorId={selected}
              root={selectedMonitor?.root_path ?? null}
              historyMode={tab === "history"}
              onModeChange={(history) => setTab(history ? "history" : "files")}
              openReq={openReq}
              onSearchInFolder={(prefix, replace) => openTextSearch(replace, prefix)}
              bottom={bottomPanel}
              treeHidden={treeHidden}
              toast={notify}
            />
          ) : (
            <div className="col main">
              <div className="empty">
                <img className="hero-logo" src="/logo.png" alt="fftracking" />
                <h3>Track a folder to begin</h3>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Kept mounted (hidden when another tab shows) so the selected file and its
          diff scroll/cursor survive a round-trip to Files and back. Keyed by the
          tracked folder so switching folders still resets it. */}
      <div
        className="work"
        style={{ gridTemplateColumns: "340px minmax(0, 1fr)", display: tab === "git" ? undefined : "none" }}
      >
        <GitView
          key={selectedMonitor?.root_path ?? "no-repo"}
          initialRepo={selectedMonitor?.root_path ?? null}
          active={tab === "git"}
          toast={notify}
          onOpenFile={(p) => openFromSearch(p)}
          conflictsIntent={conflictsIntent}
          onConflictsHandled={() => setConflictsIntent(false)}
          reloadReq={mergeReload}
        />
      </div>

      {tab === "plugins" && (
        <div className="work" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <PluginsView />
        </div>
      )}

      {tab === "settings" && (
        <div className="work" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <SettingsView toast={notify} scrollTo={settingsScroll} onOpenShortcuts={() => setShortcutsOpen(true)} />
        </div>
      )}

      {!dockInWorkspace && bottomPanel}

      <StatusBar
        tabs={{ active: tab === "history" ? "files" : tab, onSelect: (t) => setTab(t as Tab) }}
        sidebar={{ hidden: !inWorkspace || treeHidden, onToggle: toggleTree }}
        workspace={inWorkspace ? { historyOn: tab === "history", onToggle: () => setTab(tab === "history" ? "files" : "history") } : null}
        terminal={{ on: bottom === "terminal", onToggle: () => toggleBottom("terminal") }}
        conflicts={mergeConflicts}
        onShowConflicts={() => {
          setTab("git");
          setConflictsIntent(true);
        }}
      />

      {search && selected != null && (
        <SearchPalette
          monitorId={selected}
          mode={search}
          initialQuery={searchSeed}
          initialScope={searchScope}
          replaceReq={replaceReq}
          onModeChange={setSearch}
          onClose={() => setSearch(null)}
          onOpenFile={openFromSearch}
          onRevealFolder={revealFolderFromSearch}
        />
      )}

      {settingsPalette && (
        <SettingsPalette
          onClose={() => setSettingsPalette(false)}
          onSelect={(id) => {
            setSettingsPalette(false);
            if (id === "keymap") {
              setShortcutsOpen(true);
              return;
            }
            if (id === "reload") {
              window.location.reload();
              return;
            }
            if (id === "plugins") {
              setTab("plugins");
              return;
            }
            if (id === "lsp:restart") {
              const root = selectedMonitor?.root_path;
              if (!root) {
                notify("No workspace selected", true);
                return;
              }
              notify("Restarting language server…");
              restartLsp(root)
                .then(() => notify("Language server restarted"))
                .catch(() => notify("Failed to restart language server", true));
              return;
            }
            // "sec:<name>" → open the Settings tab and scroll to that section.
            const sec = id.replace(/^sec:/, "");
            setTab("settings");
            // Force the effect to refire even when re-selecting the same section.
            setSettingsScroll(null);
            requestAnimationFrame(() => setSettingsScroll(sec));
          }}
        />
      )}

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

      {/* First-run keyboard-style chooser; the persisted flag gates it to a
          single appearance on fresh installs (upgraders are pre-marked). */}
      {!prefs.keymapStyleChosen && <KeymapStyleModal onDone={() => {}} />}

      {confirmDel && (
        <ConfirmModal
          title="Delete folder & history"
          danger
          suppressId="deleteFolder"
          message={
            <>
              Permanently delete all breaking points for <b>{confirmDel.root_path}</b> and stop tracking
              it? This cannot be undone. To stop tracking without losing history, switch to a different
              project instead.
            </>
          }
          confirmLabel="Delete everything"
          onConfirm={() => deleteFolder(confirmDel.id)}
          onCancel={() => setConfirmDel(null)}
        />
      )}

      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

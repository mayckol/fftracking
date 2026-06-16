import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "./lib/ipc";
import { comboFor, formatCombo, installShortcuts, useShortcut } from "./lib/shortcuts";
import { useUIPrefs } from "./lib/uiPrefs";
import { isConfirmSuppressed } from "./lib/confirmPrefs";
import { getSelectedText } from "./lib/selection";
import { foldAtCursor, resetZoom, unfoldAtCursor, zoomIn, zoomOut } from "./lib/editorActions";
import { getScopeDir } from "./lib/searchScope";
import { setTerminalOpener } from "./lib/runner";
import { getRunSnapshot, setRunOpener, subscribeRun } from "./lib/run";
import { restartLsp } from "./lib/lsp";
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
import type { MonitorRow, ResourceUsage } from "./lib/types";
import GitView from "./panels/GitView";
import HistoryView from "./panels/HistoryView";
import SettingsView from "./panels/SettingsView";
import PluginsView from "./panels/PluginsView";
import Sidebar from "./panels/Sidebar";
import StatusBar from "./components/StatusBar";
import TerminalPanel from "./panels/TerminalPanel";
import DebugPanel from "./panels/DebugPanel";
import RunPanel from "./panels/RunPanel";

type Tab = "files" | "history" | "git" | "plugins" | "settings";

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
  const [sideOpen, setSideOpen] = useState(false);
  // Manual show/hide of the project file tree, toggled from the bottom status bar.
  const [treeHidden, setTreeHidden] = useState(false);
  const toastTimer = useRef<number>();
  const prefs = useUIPrefs();
  // Shown in the titlebar — read from tauri.conf.json (the version of record,
  // which CI keeps in sync with the release tag) instead of a hardcoded string.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

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
    const t = window.setInterval(tick, 2000);
    return () => window.clearInterval(t);
  }, []);

  const notify = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const loadMonitors = useCallback(async () => {
    const rows = await api.listMonitors();
    setMonitors(rows);
    setSelected((cur) => cur ?? rows[0]?.id ?? null);
  }, []);

  useEffect(() => {
    loadMonitors();
    const t = window.setInterval(loadMonitors, 4000); // reflect daemon-added folders
    return () => window.clearInterval(t);
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

  async function toggleFolder(m: MonitorRow) {
    try {
      if (m.active) await api.stopMonitor(m.id);
      else await api.startMonitor(m.id);
      await loadMonitors();
      notify(m.active ? "Stopped tracking (history kept)" : "Tracking resumed");
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
  useShortcut("nav.history", () => setTab("history"));
  useShortcut("nav.git", () => setTab("git"));
  useShortcut("nav.settings", () => setTab("settings"));
  const inWorkspace = tab === "files" || tab === "history";
  useShortcut("capture.snapshot", snapshotNow, inWorkspace && selected != null);
  useShortcut("terminal.toggle", () => toggleBottom("terminal"));
  useShortcut("run.toggle", () => toggleBottom("run"));
  useShortcut("settings.palette", () => setSettingsPalette((v) => !v));
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
        <div className="brand">
          <span className="dot" />
          fftracking
          {appVersion && <small>v{appVersion}</small>}
        </div>
        <div className="spacer" />
        {res && (
          <div className="res-meter" title="fftracking CPU and memory usage">
            <span>
              <i className="rm-dot cpu" />
              {res.cpu_percent.toFixed(res.cpu_percent < 10 ? 1 : 0)}%
            </span>
            <span>
              <i className="rm-dot mem" />
              {(res.mem_bytes / 1048576).toFixed(0)} MB
            </span>
          </div>
        )}
        <div className="split-btn">
          <button
            className={`tbtn${bottom === "run" ? " on" : ""}`}
            onClick={() => toggleBottom("run")}
            title={`${bottom === "run" ? "Hide" : "Show"} run panel (${formatCombo(comboFor("run.toggle"))})`}
          >
            {runActive ? "▶ Run ●" : "▶ Run"}
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
            {dbgActive ? "🐞 Debug ●" : "🐞 Debug"}
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
        <button
          className={`tbtn${bottom === "terminal" ? " on" : ""}`}
          onClick={() => toggleBottom("terminal")}
          title={`${bottom === "terminal" ? "Hide" : "Show"} terminal (${formatCombo(comboFor("terminal.toggle"))})`}
        >
          {">_ Terminal"}
        </button>
      </header>

      {(tab === "files" || tab === "history") && (
        <div
          className="work"
          style={{ gridTemplateColumns: prefs.autohideSidebar ? "minmax(0, 1fr)" : "232px minmax(0, 1fr)" }}
        >
          {prefs.autohideSidebar ? (
            <div
              className={`side-float${sideOpen ? " open" : ""}`}
              onMouseEnter={() => setSideOpen(true)}
              onMouseLeave={() => setSideOpen(false)}
            >
              <Sidebar
                monitors={monitors}
                selected={selected}
                deletingId={deletingId}
                onSelect={setSelected}
                onAdd={addFolder}
                onToggle={toggleFolder}
                onDelete={askDelete}
              />
            </div>
          ) : (
            <Sidebar
              monitors={monitors}
              selected={selected}
              deletingId={deletingId}
              onSelect={setSelected}
              onAdd={addFolder}
              onToggle={toggleFolder}
              onDelete={askDelete}
            />
          )}
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

      {tab === "git" && (
        <div className="work" style={{ gridTemplateColumns: "340px minmax(0, 1fr)" }}>
          <GitView
            initialRepo={selectedMonitor?.root_path ?? null}
            toast={notify}
            onOpenFile={(p) => openFromSearch(p)}
          />
        </div>
      )}

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
        sidebar={inWorkspace ? { hidden: treeHidden, onToggle: () => setTreeHidden((v) => !v) } : null}
        workspace={inWorkspace ? { historyOn: tab === "history", onToggle: () => setTab(tab === "history" ? "files" : "history") } : null}
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
              it? This cannot be undone. To pause without losing history, use <b>⏸ Stop</b> instead.
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

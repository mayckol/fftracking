import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/ipc";
import { comboFor, formatCombo, installShortcuts, useShortcut } from "./lib/shortcuts";
import { useUIPrefs } from "./lib/uiPrefs";
import { isConfirmSuppressed } from "./lib/confirmPrefs";
import { getSelectedText } from "./lib/selection";
import { getScopeDir } from "./lib/searchScope";
import { setTerminalOpener } from "./lib/runner";
import ConfirmModal from "./components/ConfirmModal";
import SearchPalette, { type PaletteMode } from "./components/SearchPalette";
import type { MonitorRow, ResourceUsage } from "./lib/types";
import GitView from "./panels/GitView";
import HistoryView from "./panels/HistoryView";
import SettingsView from "./panels/SettingsView";
import Sidebar from "./panels/Sidebar";
import TerminalPanel from "./panels/TerminalPanel";

type Tab = "files" | "history" | "git" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("files");
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [res, setRes] = useState<ResourceUsage | null>(null);
  const [confirmDel, setConfirmDel] = useState<MonitorRow | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showTerm, setShowTerm] = useState(false);
  const [search, setSearch] = useState<PaletteMode | null>(null);
  // Bumped by ⌘⇧R: tells the palette to open its replace row. Reset on close
  // so a later plain ⌘⇧F doesn't reopen with replace enabled.
  const [replaceReq, setReplaceReq] = useState(0);
  useEffect(() => {
    if (search === null) setReplaceReq(0);
  }, [search]);
  // Open-a-file request from the search palette, routed into HistoryView.
  const [openReq, setOpenReq] = useState<{
    monitorId: number;
    path: string;
    line?: number;
    col?: number;
    n: number;
  } | null>(null);
  const [termH, setTermH] = useState(280);
  const [sideOpen, setSideOpen] = useState(false);
  const toastTimer = useRef<number>();
  const prefs = useUIPrefs();

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
    setTerminalOpener(() => setShowTerm(true));
    return () => setTerminalOpener(null);
  }, []);
  useShortcut("nav.history", () => setTab("history"));
  useShortcut("nav.git", () => setTab("git"));
  useShortcut("nav.settings", () => setTab("settings"));
  const inWorkspace = tab === "files" || tab === "history";
  useShortcut("capture.snapshot", snapshotNow, inWorkspace && selected != null);
  useShortcut("terminal.toggle", () => setShowTerm((v) => !v));
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

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="dot" />
          fftracking
          <small>v0.5.8 · build {__BUILD_ID__}</small>
        </div>
        <nav className="tabs">
          {(["files", "history", "git", "settings"] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
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
        <button
          className={`tbtn${showTerm ? " on" : ""}`}
          onClick={() => setShowTerm((v) => !v)}
          title={`${showTerm ? "Hide" : "Show"} terminal (${formatCombo(comboFor("terminal.toggle"))})`}
        >
          {">_ Terminal"}
        </button>
        {inWorkspace && selected != null && (
          <button className="tbtn primary" onClick={snapshotNow}>
            ⦿ Snapshot now
          </button>
        )}
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
              toast={notify}
            />
          ) : (
            <div className="col main">
              <div className="empty">
                <img className="hero-logo" src="/logo.png" alt="fftracking" />
                <h3>Track a folder to begin</h3>
                <p>Add a folder, or just open a project in VSCode or Zed — fftracking picks it up automatically.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "git" && (
        <div className="work" style={{ gridTemplateColumns: "340px minmax(0, 1fr)" }}>
          <GitView initialRepo={selectedMonitor?.root_path ?? null} toast={notify} />
        </div>
      )}

      {tab === "settings" && (
        <div className="work" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <SettingsView toast={notify} />
        </div>
      )}

      {showTerm && (
        <TerminalPanel
          cwd={selectedMonitor?.root_path ?? null}
          height={termH}
          onResize={(d) => setTermH((h) => Math.max(120, Math.min(window.innerHeight - 140, h - d)))}
          onClose={() => setShowTerm(false)}
        />
      )}

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
          onRevealFolder={(p) => api.revealPath(selected, p).catch((e) => notify(String(e), true))}
        />
      )}

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

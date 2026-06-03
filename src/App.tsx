import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/ipc";
import type { MonitorRow, ResourceUsage } from "./lib/types";
import GitView from "./panels/GitView";
import HistoryView from "./panels/HistoryView";
import SettingsView from "./panels/SettingsView";
import Sidebar from "./panels/Sidebar";

type Tab = "history" | "git" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("history");
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [res, setRes] = useState<ResourceUsage | null>(null);
  const [confirmDel, setConfirmDel] = useState<MonitorRow | null>(null);
  const toastTimer = useRef<number>();

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
    try {
      await api.removeMonitor(id);
      const rows = await api.listMonitors();
      setMonitors(rows);
      setSelected((cur) => (cur === id ? rows[0]?.id ?? null : cur));
      notify("Folder & history deleted");
    } catch (e) {
      notify(String(e), true);
    }
    setConfirmDel(null);
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

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="dot" />
          fftracking
          <small>v0.4.4 · build {__BUILD_ID__}</small>
        </div>
        <nav className="tabs">
          {(["history", "git", "settings"] as Tab[]).map((t) => (
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
        {tab === "history" && selected != null && (
          <button className="tbtn primary" onClick={snapshotNow}>
            ⦿ Snapshot now
          </button>
        )}
      </header>

      {tab === "history" && (
        <div className="work">
          <Sidebar
            monitors={monitors}
            selected={selected}
            onSelect={setSelected}
            onAdd={addFolder}
            onToggle={toggleFolder}
            onDelete={setConfirmDel}
          />
          {selected != null ? (
            <HistoryView key={selected} monitorId={selected} toast={notify} />
          ) : (
            <>
              <div className="col" />
              <div className="col main">
                <div className="empty">
                  <img className="hero-logo" src="/logo.png" alt="fftracking" />
                  <h3>Track a folder to begin</h3>
                  <p>Add a folder, or just open a project in VSCode or Zed — fftracking picks it up automatically.</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "git" && (
        <div className="work" style={{ gridTemplateColumns: "340px 1fr" }}>
          <GitView initialRepo={selectedMonitor?.root_path ?? null} toast={notify} />
        </div>
      )}

      {tab === "settings" && (
        <div className="work" style={{ gridTemplateColumns: "1fr" }}>
          <SettingsView toast={notify} />
        </div>
      )}

      {confirmDel && (
        <div className="modal-overlay" onClick={() => setConfirmDel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete folder &amp; history</h3>
            <p>
              Permanently delete all breaking points for <b>{confirmDel.root_path}</b> and stop
              tracking it? This cannot be undone. To pause without losing history, use <b>⏸ Stop</b> instead.
            </p>
            <div className="modal-actions">
              <button className="tbtn" onClick={() => setConfirmDel(null)}>
                Cancel
              </button>
              <button className="tbtn danger" onClick={() => deleteFolder(confirmDel.id)}>
                Delete everything
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

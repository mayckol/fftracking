import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import type { Settings } from "../lib/types";
import { FONT_CHOICES, type GoImportStyle, type TabOverflow, setPref, useUIPrefs } from "../lib/uiPrefs";

interface Props {
  toast: (msg: string, error?: boolean) => void;
  onOpenShortcuts: () => void;
  // Section to scroll into view when the settings palette routes here.
  scrollTo?: string | null;
}

export default function SettingsView({ toast, onOpenShortcuts, scrollTo }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [autostart, setAutostart] = useState(false);
  const prefs = useUIPrefs();

  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`set-${scrollTo}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollTo]);

  useEffect(() => {
    api.getSettings().then(setS);
    api.autostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  async function save(key: string, value: string) {
    try {
      await api.setSetting(key, value);
      toast("Saved");
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function toggleAutostart(on: boolean) {
    try {
      await api.setAutostart(on);
      setAutostart(on);
      toast(on ? "Will launch on login" : "Autostart disabled");
    } catch (e) {
      toast(String(e), true);
    }
  }

  if (!s) return <div className="col main" />;

  return (
    <div className="col main">
      <div className="pane narrow">
        <div className="section-title" id="set-capture">Capture</div>

        <div className="field">
          <label>
            Interval snapshot
            <span className="hint">Timed breaking point, in addition to on-save capture.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={Math.round(s.default_interval_secs / 60)}
              onBlur={(e) => save("default_interval_secs", String(Math.max(1, +e.target.value) * 60))}
              style={{ width: 90 }}
            />{" "}
            minutes
          </div>
        </div>

        <div className="field">
          <label>
            Min gap between auto-points
            <span className="hint">Coalesce rapid saves (e.g. live-reload) into at most one breaking point per this many seconds.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={s.event_min_gap_secs}
              onBlur={(e) => save("event_min_gap_secs", String(Math.max(1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            seconds
          </div>
        </div>

        <div className="field">
          <label>
            Ignore globs
            <span className="hint">One per line. Added to built-ins (.git, node_modules, target…).</span>
          </label>
          <textarea
            defaultValue={s.ignore_globs.join("\n")}
            placeholder={"*.log\ntmp/**"}
            onBlur={(e) => save("ignore_globs", e.target.value)}
          />
        </div>

        <div className="field">
          <label>
            Respect .gitignore
            <span className="hint">
              Off (default) tracks everything like local history — including .env and other gitignored files. On skips them.
            </span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              defaultChecked={s.respect_gitignore}
              onChange={(e) => save("respect_gitignore", e.target.checked ? "1" : "0")}
            />
            <span className="changecount">{s.respect_gitignore ? "Skipping gitignored" : "Tracking everything"}</span>
          </label>
        </div>

        <div className="section-title" id="set-retention">Retention</div>

        <div className="field">
          <label>
            Keep history for
            <span className="hint">Older breaking points are pruned. Labeled points are always kept.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={s.retention_days}
              onBlur={(e) => save("retention_days", String(Math.max(1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            days
          </div>
        </div>

        <div className="field">
          <label>
            Points per past day
            <span className="hint">Today stays dense; past days coalesce to this many.</span>
          </label>
          <input
            type="number"
            min={1}
            max={10}
            defaultValue={s.snapshots_per_past_day}
            onBlur={(e) => save("snapshots_per_past_day", String(Math.max(1, +e.target.value)))}
            style={{ width: 90 }}
          />
        </div>

        <div className="field">
          <label>
            Disk cap
            <span className="hint">Oldest sparse days are evicted to stay under this.</span>
          </label>
          <div>
            <input
              type="number"
              min={0.1}
              step={0.1}
              defaultValue={s.max_disk_gb}
              onBlur={(e) => save("max_disk_gb", String(Math.max(0.1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            GB
          </div>
        </div>

        <div className="section-title" id="set-system">System</div>

        <div className="field">
          <label>
            Launch on login
            <span className="hint">Run in the tray and auto-track folders opened in VSCode / Zed.</span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={autostart} onChange={(e) => toggleAutostart(e.target.checked)} />
            <span className="changecount">{autostart ? "Enabled" : "Disabled"}</span>
          </label>
        </div>

        <div className="section-title" id="set-interface">Interface</div>

        <div className="field">
          <label>
            Editor font
            <span className="hint">Font family for the file viewer and diff. Falls back to the system monospace.</span>
          </label>
          <select
            value={prefs.fontFamily}
            onChange={(e) => setPref("fontFamily", e.target.value)}
            style={{ width: 200, fontFamily: `${prefs.fontFamily}, monospace` }}
          >
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f} style={{ fontFamily: `${f}, monospace` }}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Editor font size
            <span className="hint">In pixels.</span>
          </label>
          <input
            type="number"
            min={9}
            max={28}
            step={0.5}
            value={prefs.fontSize}
            onChange={(e) => setPref("fontSize", Math.max(9, Math.min(28, +e.target.value || 12.5)))}
            style={{ width: 90 }}
          />
        </div>

        <div className="field">
          <label>
            Indentation guides
            <span className="hint">Vertical lines marking each indent level (block depth).</span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={prefs.indentGuides}
              onChange={(e) => setPref("indentGuides", e.target.checked)}
            />
            <span className="changecount">{prefs.indentGuides ? "Showing guides" : "Hidden"}</span>
          </label>
        </div>

        <div className="field">
          <label>
            Auto-hide monitored sidebar
            <span className="hint">
              Hide the projects sidebar; reveal it by moving the pointer to the left edge (like the macOS menu bar).
            </span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={prefs.autohideSidebar}
              onChange={(e) => setPref("autohideSidebar", e.target.checked)}
            />
            <span className="changecount">{prefs.autohideSidebar ? "Auto-hide on" : "Always visible"}</span>
          </label>
        </div>

        <div className="field">
          <label>
            Max open file tabs
            <span className="hint">Upper bound on editor tabs kept open at once.</span>
          </label>
          <input
            type="number"
            min={1}
            max={40}
            value={prefs.maxTabs}
            onChange={(e) => setPref("maxTabs", Math.max(1, Math.min(40, +e.target.value || 1)))}
            style={{ width: 90 }}
          />
        </div>

        <div className="field">
          <label>
            Format on save
            <span className="hint">
              Run the language formatter (gofmt for Go) before writing the file with ⌘S. Also available any time with ⌘⇧L.
            </span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={prefs.formatOnSave}
              onChange={(e) => setPref("formatOnSave", e.target.checked)}
            />
            <span className="changecount">{prefs.formatOnSave ? "Format on save" : "Save as-is"}</span>
          </label>
        </div>

        <div className="field">
          <label>
            Go import grouping
            <span className="hint">
              How auto-import places new imports. Follow .golangci.yml uses the gci sections (or
              goimports local-prefixes) from the workspace config; Match existing groups mirrors the
              file's current layout; Flat keeps one alphabetical block.
            </span>
          </label>
          <select
            value={prefs.goImportStyle}
            onChange={(e) => setPref("goImportStyle", e.target.value as GoImportStyle)}
            style={{ width: 200 }}
          >
            <option value="golangci">Follow .golangci.yml</option>
            <option value="grouped">Match existing groups</option>
            <option value="flat">Flat (alphabetical)</option>
          </select>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input
              type="checkbox"
              checked={prefs.goImportsOnSave}
              onChange={(e) => setPref("goImportsOnSave", e.target.checked)}
            />
            <span className="changecount">Regroup whole import block on save</span>
          </label>
        </div>

        <div className="field">
          <label>
            When the tab limit is reached
            <span className="hint">
              Close oldest drops the least-recently opened tab to make room; Block keeps your tabs and refuses to open more until you close one.
            </span>
          </label>
          <select
            value={prefs.tabOverflow}
            onChange={(e) => setPref("tabOverflow", e.target.value as TabOverflow)}
            style={{ width: 200 }}
          >
            <option value="fifo">Close oldest (FIFO)</option>
            <option value="block">Block new tabs</option>
          </select>
        </div>

        <div className="section-title" id="set-shortcuts">Shortcuts</div>
        <div className="field">
          <label>
            Keyboard shortcuts
            <span className="hint">View and rebind every shortcut. Search by name or by pressing a key.</span>
          </label>
          <button className="tbtn" onClick={onOpenShortcuts}>
            Open keyboard shortcuts…
          </button>
        </div>
      </div>
    </div>
  );
}

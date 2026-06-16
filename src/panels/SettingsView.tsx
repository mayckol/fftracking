import { useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import type { Settings } from "../lib/types";
import {
  TRANSFER_SECTIONS,
  applyImport,
  buildExport,
  parseBundle,
  sectionsInBundle,
  type SettingsBundle,
} from "../lib/settingsTransfer";
import {
  FONT_CHOICES,
  type GoImportStyle,
  type KeymapStyle,
  type TabOverflow,
  revertToOriginal,
  revertToPrevious,
  setKeymapStyle,
  setPref,
  useUIPrefs,
} from "../lib/uiPrefs";
import { comboFor, formatCombo, IS_MAC } from "../lib/shortcuts";
import { THEMES } from "../lib/themes";
import { ICON_PACKS } from "../lib/iconPacks";

// Representative shortcuts shown as a live preview under the keyboard-style picker.
const KEYMAP_PREVIEW = [
  { id: "editor.save", label: "Save" },
  { id: "editor.deleteLine", label: "Delete line" },
  { id: "search.text", label: "Find in files" },
];

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
  const [exportSel, setExportSel] = useState<Set<string>>(() => new Set(TRANSFER_SECTIONS.map((x) => x.id)));
  const [imported, setImported] = useState<{ bundle: SettingsBundle; available: string[] } | null>(null);
  const [importSel, setImportSel] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = (id: string, set: (fn: (p: Set<string>) => Set<string>) => void) =>
    set((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  async function doExport() {
    const ids = [...exportSel];
    if (!ids.length) return toast("Pick at least one section to export", true);
    try {
      const text = JSON.stringify(await buildExport(ids, new Date().toISOString()), null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `fftracking-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Settings exported");
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function copyExport() {
    const ids = [...exportSel];
    if (!ids.length) return toast("Pick at least one section to export", true);
    try {
      const text = JSON.stringify(await buildExport(ids, new Date().toISOString()), null, 2);
      await navigator.clipboard.writeText(text);
      toast("Settings JSON copied to clipboard");
    } catch (e) {
      toast(String(e), true);
    }
  }

  function loadBundleText(text: string) {
    try {
      const bundle = parseBundle(text);
      const available = sectionsInBundle(bundle);
      if (!available.length) return toast("No known settings in that file", true);
      setImported({ bundle, available });
      setImportSel(new Set(available));
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function doImport() {
    if (!imported) return;
    const ids = [...importSel];
    if (!ids.length) return toast("Pick at least one section to import", true);
    try {
      await applyImport(imported.bundle, ids);
      toast("Settings imported — reloading…");
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      toast(String(e), true);
    }
  }

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
            Theme
            <span className="hint">Colors for the whole app: panels, chrome, editor and diff.</span>
          </label>
          <select value={prefs.theme} onChange={(e) => setPref("theme", e.target.value)} style={{ width: 200 }}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            File icons
            <span className="hint">Icon set for the project tree, tabs and search results.</span>
          </label>
          <select value={prefs.iconPack} onChange={(e) => setPref("iconPack", e.target.value)} style={{ width: 200 }}>
            {ICON_PACKS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Folder &amp; file font
            <span className="hint">Font family for folder and file names in the project tree.</span>
          </label>
          <select
            value={prefs.treeFont}
            onChange={(e) => setPref("treeFont", e.target.value)}
            style={{ width: 200, fontFamily: prefs.treeFont }}
          >
            <option value="Archivo" style={{ fontFamily: "Archivo" }}>
              Archivo (UI)
            </option>
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f} style={{ fontFamily: `${f}, monospace` }}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Folder &amp; file size
            <span className="hint">Font size of project-tree names, in pixels.</span>
          </label>
          <input
            type="number"
            min={9}
            max={22}
            step={0.5}
            value={prefs.treeFontSize}
            onChange={(e) => setPref("treeFontSize", Math.max(9, Math.min(22, +e.target.value || 11.5)))}
            style={{ width: 90 }}
          />
        </div>

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
            Auto save
            <span className="hint">
              Write edits to disk automatically a moment after you stop typing. Turn off to save only
              with {formatCombo(comboFor("editor.save"))}. Unsaved files show a dot in their tab.
            </span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={prefs.autoSave}
              onChange={(e) => setPref("autoSave", e.target.checked)}
            />
            <span className="changecount">{prefs.autoSave ? "Auto save on" : "Manual save"}</span>
          </label>
        </div>

        <div className="field">
          <label>
            Format on save
            <span className="hint">
              Run the language formatter (gofmt for Go) before writing the file with {formatCombo(comboFor("editor.save"))}. Also
              available any time with {formatCombo(comboFor("editor.format"))}.
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
            Keyboard style
            <span className="hint">
              {IS_MAC
                ? "Native uses ⌘. Switch to Windows / Linux style to drive shortcuts from Ctrl instead."
                : "Native uses Ctrl (recommended on Linux). macOS style maps the key next to the spacebar (Alt) to ⌘ and Ctrl to ⌥ for mac muscle memory — but on Linux the window manager reserves many Alt shortcuts, so some won't reach the app."}
            </span>
          </label>
          <select
            value={prefs.keymapStyle}
            onChange={(e) => setKeymapStyle(e.target.value as KeymapStyle)}
            style={{ width: 260 }}
          >
            <option value="native">Native ({IS_MAC ? "macOS" : "Windows / Linux"})</option>
            <option value="mac">macOS style (⌘)</option>
            <option value="pc">Windows / Linux style (Ctrl)</option>
          </select>
          <div className="keymap-preview" style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
            {KEYMAP_PREVIEW.map((p) => (
              <span key={p.id} className="changecount" style={{ display: "inline-flex", gap: 6 }}>
                {p.label}
                <code>{formatCombo(comboFor(p.id))}</code>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="tbtn" onClick={revertToOriginal} disabled={prefs.keymapStyle === "native"}>
              Revert to original
            </button>
            <button
              className="tbtn"
              onClick={revertToPrevious}
              disabled={prefs.keymapStylePrev === prefs.keymapStyle}
              title="Undo the last keyboard-style change"
            >
              Revert to previous
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            Keyboard shortcuts
            <span className="hint">View and rebind every shortcut. Search by name or by pressing a key.</span>
          </label>
          <button className="tbtn" onClick={onOpenShortcuts}>
            Open keyboard shortcuts…
          </button>
        </div>

        <div className="section-title" id="set-backup">Backup &amp; transfer</div>

        <div className="field">
          <label>
            Export settings
            <span className="hint">Pick what to include, then download a JSON file (or copy it). Per-folder tracking history is not included.</span>
          </label>
          <div className="xfer-list">
            {TRANSFER_SECTIONS.map((sec) => (
              <label key={sec.id} className="xfer-row" title={sec.hint}>
                <input type="checkbox" checked={exportSel.has(sec.id)} onChange={() => toggle(sec.id, setExportSel)} />
                <span className="xfer-label">{sec.label}</span>
                <span className="hint xfer-hint">{sec.hint}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="tbtn primary" onClick={doExport}>
              Export selected…
            </button>
            <button className="tbtn" onClick={copyExport}>
              Copy JSON
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            Import settings
            <span className="hint">Load a settings file, choose which sections to apply, then import. The app reloads to apply them.</span>
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.currentTarget.value = "";
              if (f) f.text().then(loadBundleText).catch((err) => toast(String(err), true));
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="tbtn" onClick={() => fileRef.current?.click()}>
              Choose file…
            </button>
          </div>
          {imported && (
            <>
              <div className="xfer-list" style={{ marginTop: 8 }}>
                {TRANSFER_SECTIONS.filter((sec) => imported.available.includes(sec.id)).map((sec) => (
                  <label key={sec.id} className="xfer-row" title={sec.hint}>
                    <input type="checkbox" checked={importSel.has(sec.id)} onChange={() => toggle(sec.id, setImportSel)} />
                    <span className="xfer-label">{sec.label}</span>
                    <span className="hint xfer-hint">{sec.hint}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="tbtn primary" onClick={doImport}>
                  Apply import
                </button>
                <button className="tbtn" onClick={() => setImported(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

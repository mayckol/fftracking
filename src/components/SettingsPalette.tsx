import { useEffect, useRef, useState } from "react";

export interface SettingsEntry {
  id: string;
  label: string;
  hint: string;
  keywords: string;
}

const ENTRIES: SettingsEntry[] = [
  { id: "keymap", label: "Keyboard Shortcuts", hint: "Keymap — view & rebind", keywords: "keymap shortcut keybinding hotkey combo" },
  { id: "sec:capture", label: "Capture", hint: "Interval, min gap, ignore globs, .gitignore", keywords: "snapshot interval ignore gitignore breaking point" },
  { id: "sec:retention", label: "Retention", hint: "History length, points per day, disk cap", keywords: "retention prune days disk cap storage" },
  { id: "sec:system", label: "System", hint: "Launch on login", keywords: "autostart login tray startup" },
  { id: "sec:interface", label: "Interface", hint: "Font, size, guides, tabs, formatting", keywords: "font size indent tabs format import sidebar theme" },
  { id: "lsp:restart", label: "Restart Language Server", hint: "Restart gopls for the workspace", keywords: "gopls lsp language server restart reload go diagnostics" },
  { id: "reload", label: "Reload app", hint: "Restart the window", keywords: "reload restart refresh window" },
];

interface Props {
  onClose: () => void;
  onSelect: (id: string) => void;
}

export default function SettingsPalette({ onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const rows = ENTRIES.filter(
    (e) => !q || e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q) || e.keywords.includes(q),
  );

  useEffect(() => setSel(0), [query]);

  function accept(i: number) {
    const row = rows[i];
    if (!row) return;
    onSelect(row.id);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(rows.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      accept(sel);
    }
  }

  return (
    <div className="modal-overlay palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-head">
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder="Search settings…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="palette-list">
          {rows.length === 0 ? (
            <div className="palette-note">No settings match</div>
          ) : (
            rows.map((r, i) => (
              <div
                key={r.id}
                className={`palette-row${i === sel ? " on" : ""}`}
                onMouseMove={() => setSel(i)}
                onClick={() => accept(i)}
              >
                <span className="palette-name">{r.label}</span>
                <span className="palette-hint">{r.hint}</span>
              </div>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span className="palette-keys">↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useReducer, useState } from "react";
import {
  ACTIONS,
  type ActionGroup,
  beginCapture,
  comboFor,
  formatCombo,
  resetCombo,
  setCombo,
  subscribe,
} from "../lib/shortcuts";

const GROUP_ORDER: ActionGroup[] = [
  "Editor",
  "Diff",
  "Capture & revert",
  "Changed files",
  "Navigation",
  "Search",
  "Debug",
];

interface Props {
  onClose: () => void;
}

export default function ShortcutsModal({ onClose }: Props) {
  const [, force] = useReducer((x) => x + 1, 0);
  const [text, setText] = useState("");
  // Rebinding: which action is listening for its new combo.
  const [capturing, setCapturing] = useState<string | null>(null);
  // "Find by keystroke": filter the list to whatever action owns a pressed combo.
  const [finding, setFinding] = useState(false);
  const [keyFilter, setKeyFilter] = useState("");

  useEffect(() => subscribe(force), []);

  // Esc closes — but only when no capture is in flight (the global capture
  // handler swallows Esc to cancel a rebind / find first).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || capturing || finding) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [onClose, capturing, finding]);

  function rebind(id: string) {
    setCapturing(id);
    beginCapture((combo) => {
      setCapturing(null);
      if (combo === "Escape") return;
      setCombo(id, combo);
    });
  }

  function findByKey() {
    setFinding(true);
    setText("");
    beginCapture((combo) => {
      setFinding(false);
      if (combo === "Escape") return;
      setKeyFilter(combo);
    });
  }

  function clearKeyFilter() {
    setKeyFilter("");
  }

  const q = text.trim().toLowerCase();
  const rows = ACTIONS.filter((a) => {
    if (keyFilter) return comboFor(a.id) === keyFilter;
    if (!q) return true;
    return (
      a.label.toLowerCase().includes(q) ||
      a.group.toLowerCase().includes(q) ||
      formatCombo(comboFor(a.id)).toLowerCase().includes(q)
    );
  });

  return (
    <div className="modal-overlay palette-overlay" onClick={onClose}>
      <div className="palette shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <input
            autoFocus
            value={finding ? "" : text}
            spellCheck={false}
            disabled={finding}
            placeholder={finding ? "Press a shortcut…" : "Search shortcuts by name…"}
            onChange={(e) => {
              setKeyFilter("");
              setText(e.target.value);
            }}
          />
          <div className="palette-opts">
            <button
              className={finding || keyFilter ? "on" : ""}
              title="Find the action bound to a key — then press the combination"
              onClick={findByKey}
            >
              ⌨ By key
            </button>
          </div>
        </div>

        {keyFilter && (
          <div className="palette-scope">
            <span>
              bound to <code>{formatCombo(keyFilter)}</code>
            </span>
            <button title="Clear keystroke filter" onClick={clearKeyFilter}>
              × clear
            </button>
          </div>
        )}

        <div className="palette-list">
          {rows.length === 0 ? (
            <div className="palette-note">No shortcuts match</div>
          ) : (
            GROUP_ORDER.map((group) => {
              const items = rows.filter((a) => a.group === group);
              if (items.length === 0) return null;
              return (
                <div className="palette-group" key={group}>
                  <div className="palette-file">
                    <span className="palette-name">{group}</span>
                  </div>
                  <div className="keys">
                    {items.map((a) => (
                      <div className="key-row" key={a.id}>
                        <span className="key-label">{a.label}</span>
                        <button
                          className={`tbtn key-combo${capturing === a.id ? " capturing" : ""}`}
                          onClick={() => rebind(a.id)}
                          title="Click, then press the new shortcut"
                        >
                          {capturing === a.id ? "Press keys…" : formatCombo(comboFor(a.id))}
                        </button>
                        <button className="tbtn key-reset" title="Reset to default" onClick={() => resetCombo(a.id)}>
                          ↺
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="palette-foot">
          <span>Click a shortcut, then press the new combination (Esc to cancel).</span>
          <span className="palette-keys">esc close</span>
        </div>
      </div>
    </div>
  );
}

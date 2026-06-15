import { useState } from "react";
import { type KeymapStyle, markKeymapChosen, setKeymapStyle } from "../lib/uiPrefs";
import { comboFor, formatComboFor, IS_MAC } from "../lib/shortcuts";

interface Props {
  onDone: () => void;
}

const PREVIEW = [
  { id: "editor.save", label: "Save" },
  { id: "editor.deleteLine", label: "Delete line" },
  { id: "search.text", label: "Find in files" },
];

// The two choices offered, oldest-first. The cross-platform option depends on
// the host OS: a Mac offers Windows/Linux style, a PC offers macOS style.
const NATIVE: { style: KeymapStyle; title: string; blurb: string } = {
  style: "native",
  title: IS_MAC ? "Native (macOS)" : "Native (Windows / Linux)",
  blurb: IS_MAC ? "Use ⌘ as the primary modifier, like every other Mac app." : "Use Ctrl as the primary modifier — the platform default.",
};
const ALT: { style: KeymapStyle; title: string; blurb: string } = IS_MAC
  ? {
      style: "pc",
      title: "Windows / Linux style",
      blurb: "Drive shortcuts from Ctrl instead of ⌘.",
    }
  : {
      style: "mac",
      title: "macOS style",
      blurb: "Map the key next to the spacebar (Alt) to ⌘ and Ctrl to ⌥ for Mac muscle memory. On Linux the window manager reserves many Alt shortcuts, so Native is more reliable.",
    };

const OPTIONS = [NATIVE, ALT];

export default function KeymapStyleModal({ onDone }: Props) {
  const [choice, setChoice] = useState<KeymapStyle>("native");

  function confirm() {
    setKeymapStyle(choice); // marks the first-run choice as made
    onDone();
  }

  function skip() {
    markKeymapChosen();
    onDone();
  }

  return (
    <div className="modal-overlay" onClick={skip}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Choose your keyboard style</h3>
        <p>
          You can change this any time in <b>Settings → Shortcuts</b>, and revert to the original.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" }}>
          {OPTIONS.map((o) => (
            <label
              key={o.style}
              className={`keymap-card${choice === o.style ? " on" : ""}`}
              style={{
                display: "block",
                padding: "10px 12px",
                border: "1px solid var(--hairline, #333)",
                borderRadius: 8,
                cursor: "pointer",
                outline: choice === o.style ? "2px solid var(--accent, #7aa2f7)" : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="radio"
                  name="keymap-style"
                  checked={choice === o.style}
                  onChange={() => setChoice(o.style)}
                />
                <b>{o.title}</b>
              </div>
              <div className="hint" style={{ margin: "4px 0 8px 24px" }}>
                {o.blurb}
              </div>
              <div style={{ display: "flex", gap: 14, marginLeft: 24, flexWrap: "wrap" }}>
                {PREVIEW.map((p) => (
                  <span key={p.id} className="changecount" style={{ display: "inline-flex", gap: 6 }}>
                    {p.label}
                    <code>{formatComboFor(comboFor(p.id), o.style)}</code>
                  </span>
                ))}
              </div>
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button className="tbtn" onClick={skip}>
            Skip
          </button>
          <button className="tbtn primary" onClick={confirm}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

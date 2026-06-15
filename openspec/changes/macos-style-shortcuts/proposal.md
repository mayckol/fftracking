# macOS-style Shortcuts (cross-platform keymap style)

## Why

Shortcuts are hard-wired to the host OS: `IS_MAC` (computed once from `navigator.platform`) decides whether the primary modifier renders as ⌘ or Ctrl, and `comboFromEvent` always collapses `metaKey || ctrlKey` into `"Mod"`. A developer who lives on macOS but works on Linux has no way to keep their muscle memory — on Linux the command-style key next to the spacebar (physically **Alt**) does nothing useful, every shortcut is Ctrl-based, and the UI never shows ⌘/⌥. There is also no symmetric escape hatch for a macOS user who prefers Windows/Linux Ctrl-based bindings.

## What Changes

- Introduce a **keymap style** preference (`native` | `mac` | `pc`) that decouples the shortcut scheme from the host OS. `native` preserves today's behavior; `mac` and `pc` force a scheme regardless of platform.
- On **Linux/Windows under `mac` style**, swap the two left-of/right-of-space modifiers: physical **Alt → ⌘ (Mod)** and physical **Ctrl → ⌥ (Alt/Option)**. Every existing binding (`Mod+S`, `Alt+D`, `Mod+Alt+R`, …) keeps working with no rebinding and no collisions — only which physical key produces each logical modifier changes. The UI renders ⌘/⌥/⇧ with mac-style spacing.
- On **macOS under `pc` style**, drive the scheme from physical Ctrl and render Ctrl/Alt/Shift words.
- Apply the active scheme consistently in three places: the global key handler (`comboFromEvent`), combo rendering (`formatCombo`/symbols), and the Monaco editor command bindings (`toKeybinding`). Re-register live when the style changes — no app reload.
- Add a **first-run prompt** (no onboarding exists today) offered on a fresh install on every OS: choose the OS-native scheme or the cross-platform one, with a short preview. The same choice is always available later in **Settings → Shortcuts**.
- Provide **two reversibility actions** required by the user: **Revert to original** (back to the OS-native default) and **Revert to previous** (undo the last style change, swapping current ↔ previous). The previous style is remembered so any switch is undoable.
- Persist `keymapStyle`, the remembered `keymapStylePrev`, and a `keymapStyleChosen` flag in UI preferences; never interrupt upgrading users — they keep `native` and discover the control in Settings.

## Capabilities

### New Capabilities
- `keyboard-shortcut-style`: a platform-independent keymap style (`native`/`mac`/`pc`) with an OS-aware modifier scheme (including the Linux/Windows ⌘↔Alt swap for mac style), applied to event matching, combo rendering, and Monaco editor bindings; a first-run chooser; a Settings control; and revert-to-original / revert-to-previous actions.

### Modified Capabilities

None — no existing specs.

## Impact

- `src/lib/shortcuts.ts` — `IS_MAC` const and `SYMBOL`/`formatCombo`/`comboFromEvent` become scheme-driven; add the style store (load/persist/subscribe), scheme resolver, and revert actions.
- `src/components/FileView.tsx` — `toKeybinding` maps `Mod`/`Alt` per the active scheme; the editor `addCommand` effect re-registers when the style changes. Optional remap of common Monaco built-ins (copy/paste/cut/undo/redo/select-all) under mac-style-on-Linux.
- `src/lib/uiPrefs.ts` — new `keymapStyle`, `keymapStylePrev`, `keymapStyleChosen` prefs (or a dedicated `ff.keymapStyle` store) with live broadcast.
- `src/panels/SettingsView.tsx` — new "Keyboard style" control in the Shortcuts section with the two revert actions.
- `src/App.tsx` — mount a first-run `KeymapStyleModal` gated on `!keymapStyleChosen` for fresh installs.
- New component `src/components/KeymapStyleModal.tsx` (first-run chooser) and shared style/preview UI reused in Settings.
- Tooltip/label call sites that render `formatCombo(...)` (`App.tsx`, `DebugPanel.tsx`, `FileView.tsx`, `ShortcutsModal.tsx`) reflect the active scheme on next render.

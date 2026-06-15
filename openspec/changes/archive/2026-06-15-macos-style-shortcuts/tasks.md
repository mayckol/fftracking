## 1. Preference store

- [x] 1.1 Add `keymapStyle` (`"native" | "mac" | "pc"`), `keymapStylePrev`, and `keymapStyleChosen: boolean` to `UIPrefs` + `DEFAULTS` in `src/lib/uiPrefs.ts` (defaults `native`/`native`/`false`)
- [x] 1.2 Add a startup migration in `uiPrefs.load()`: if the `ff.uiPrefs` key already existed before this version, set `keymapStyleChosen: true` so upgraders are not prompted
- [x] 1.3 Add helpers `setKeymapStyle(next)` (push current → `keymapStylePrev`, then set), `revertToOriginal()` (→ `native`, recording previous), and `revertToPrevious()` (swap current ↔ previous); each persists and broadcasts via `subscribePrefs`

## 2. Scheme resolver in shortcuts.ts

- [x] 2.1 Add `type KeymapStyle` and `resolveScheme(style, isMacHost)` returning `{ matchMod(e), matchAlt(e), symbols, sep, monacoMod, monacoAlt }` for the three effective schemes (`pc`, `mac`-on-mac, `mac`-on-PC swap) per design D2
- [x] 2.2 Keep host detection (`IS_MAC`) but stop reading it directly in render/match; add a cached `currentScheme` recomputed from `getPrefs().keymapStyle` and refreshed on `subscribePrefs`
- [x] 2.3 Rewrite `comboFromEvent` to use `scheme.matchMod(e)` / `scheme.matchAlt(e)` instead of the hard-coded `metaKey || ctrlKey` / `altKey`
- [x] 2.4 Rewrite `SYMBOL`/`formatCombo` to use `scheme.symbols` + `scheme.sep` (and the DOUBLE_SHIFT rendering) instead of `IS_MAC`
- [x] 2.5 When the style changes, notify the existing `shortcuts.subscribe` set so `ShortcutsModal` and combo hints refresh
- [x] 2.6 Verify `native` reproduces the exact pre-change branches on macOS and on Linux/Windows (byte-for-byte parity)

## 3. Monaco editor bindings

- [x] 3.1 Update `toKeybinding` in `src/components/FileView.tsx` to map `"Mod"`/`"Alt"` via `scheme.monacoMod`/`scheme.monacoAlt` (mac-on-PC: `Mod`→`KeyMod.Alt`, `Alt`→`KeyMod.WinCtrl`)
- [x] 3.2 Make the editor `addCommand` registration effect depend on the active style (subscriber hook) so commands dispose + re-register live on style change
- [x] 3.3 (Optional, design Non-Goal carve-out) Under mac-on-PC, remap the common Monaco built-ins (copy/paste/cut/undo/redo/select-all) onto the swapped physical key; leave the rest documented as a known limitation

## 4. Settings control

- [x] 4.1 Add a "Keyboard style" control to the Shortcuts section of `src/panels/SettingsView.tsx` showing the current style and the OS-appropriate alternative, applying changes live via `setKeymapStyle`
- [x] 4.2 Add "Revert to original" and "Revert to previous" actions wired to `revertToOriginal()` / `revertToPrevious()`
- [x] 4.3 Show a small live preview of representative shortcuts (e.g. Save, Delete line) rendered with `formatCombo` so the user sees the effect before committing

## 5. First-run chooser

- [x] 5.1 Create `src/components/KeymapStyleModal.tsx`: symmetric per-OS options (Linux/Windows → Native vs macOS style; macOS → Native vs Windows/Linux style) with the shared picker + live preview
- [x] 5.2 Mount it in `src/App.tsx` gated on `!prefs.keymapStyleChosen`; confirming or dismissing sets `keymapStyleChosen: true` and persists any chosen style
- [x] 5.3 Ensure it shows only on a genuine fresh install and never for upgraders (covered by task 1.2)

## 6. Verification

- [x] 6.1 Linux `mac` style: physical Alt+S triggers Save (`Mod+S`); physical Ctrl+D triggers Delete line (`Alt+D`); combos render ⌘/⌥/⇧ with spaces
- [x] 6.2 macOS `pc` style: physical Ctrl drives `Mod`; combos render Ctrl/Alt/Shift with `+`
- [x] 6.3 Revert to original returns to `native`; revert to previous toggles the last change back and forth
- [x] 6.4 Live switch updates global matcher, rendered hints, and a currently-open editor's bindings without reload
- [x] 6.5 `native` users on every OS see no behavioral or visual change; `tsc` build passes

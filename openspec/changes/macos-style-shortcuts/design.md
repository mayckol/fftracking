# Design — macOS-style Shortcuts

## Context

Shortcuts live entirely in the web layer (Tauri + React). `src/lib/shortcuts.ts` owns an action registry and one global `keydown` handler; `IS_MAC = navigator.platform...MAC` is a module-level constant that drives `SYMBOL`/`formatCombo` rendering, and `comboFromEvent` always treats `metaKey || ctrlKey` as the logical `Mod`. Custom editor commands are bound separately in `src/components/FileView.tsx` via `toKeybinding`, which maps `"Mod"` → `monaco.KeyMod.CtrlCmd` (Monaco resolves that to Cmd on macOS, Ctrl elsewhere by its own platform check). Bindings persist in `localStorage` (`ff.shortcuts`); UI prefs persist in `ff.uiPrefs` with a live subscriber broadcast (`src/lib/uiPrefs.ts`).

The codebase has **no onboarding/first-run flow** today. Modals are mounted conditionally in `App.tsx` (e.g. `ShortcutsModal`). Several bindings use `Alt` as a real secondary modifier: `Alt+D`, `Alt+ArrowDown/Up`, `Alt+PageUp/Down`, `Alt+R`, `Alt+L`, and combined `Mod+Alt+R`, `Mod+Alt+C`, `Mod+Alt+ArrowLeft/Right`.

Constraint: a macOS developer working on Linux wants the command-style key next to the spacebar (physically **Alt** on a PC keyboard) to act like ⌘, while keeping every existing binding functional and showing ⌘/⌥/⇧.

## Goals / Non-Goals

**Goals:**
- A single `keymapStyle` preference (`native` | `mac` | `pc`) that overrides the host-OS-derived scheme.
- On non-mac hosts, a `mac` style that maps physical **Alt → Mod (⌘)** and physical **Ctrl → Alt (⌥)** — a swap — so all existing combos work unchanged and collisions are impossible.
- Apply the resolved scheme uniformly to: the global matcher, combo rendering, and Monaco editor bindings; switch live without reload.
- First-run chooser on fresh installs (symmetric per OS) plus an always-available Settings control.
- **Revert to original** (→ `native`) and **revert to previous** (undo last change) actions; every change is reversible.
- Zero behavioral change for `native` users on any OS.

**Non-Goals:**
- Remapping Monaco's full set of built-in editing keybindings. Only the small common set (copy/paste/cut/undo/redo/select-all) is optionally remapped under mac-on-Linux; the rest stay on Monaco's platform default and are documented as a known limitation.
- Native OS menu accelerators or window-manager-level remapping (e.g. xmodmap/keyd). This is in-app only.
- Per-action style overrides — style is global; individual rebinding already exists via `ShortcutsModal`.
- Touching the canonical combo strings or the action registry.

## Decisions

### D1 — Swap Ctrl↔Alt for mac-style on non-mac hosts (not "Alt OR Ctrl = Mod", not symbols-only)
A Mac keyboard has both ⌘ (next to space) and ⌥; a PC keyboard's key next to space is Alt and the far key is Ctrl. Mapping **physical Alt → Mod** and **physical Ctrl → Alt** relocates Option onto Ctrl, so every binding that needs a real Alt (`Alt+D`, `Mod+Alt+R`, …) keeps a home and nothing collides.

- *Rejected — "Alt OR Ctrl both fire Mod":* pressing Alt+D would fire `Mod+D` instead of the intended `Alt+D` action; bindings that need a distinct Alt break.
- *Rejected — symbols-only:* renders ⌘ but the physical key is still Ctrl; doesn't satisfy "use Alt as cmd".

The swap lives only in the physical→logical mapping; canonical strings and the registry are untouched.

### D2 — A resolved `Scheme` computed from `(style, isMacHost)`
Introduce `resolveScheme(style, isMacHost)` returning the data the three surfaces need:
```
effective = style === "native" ? (isMacHost ? "mac" : "pc") : style

pc:               Mod ← Ctrl(/Meta) , Alt ← Alt ; render Ctrl/Alt/Shift, sep "+"
mac on mac host:  Mod ← Meta(/Ctrl) , Alt ← Alt ; render ⌘/⌥/⇧,        sep " "
mac on PC host:   Mod ← Alt(/Meta)  , Alt ← Ctrl; render ⌘/⌥/⇧,        sep " "   (the swap)
```
Each scheme exposes: `matchMod(e)`/`matchAlt(e)` predicates for `comboFromEvent`; `symbols` + `sep` for `formatCombo`; and a Monaco modifier map (`Mod`→`CtrlCmd|Alt`, `Alt`→`Alt|WinCtrl`) for `toKeybinding`.

`IS_MAC` stays as the host detector but is **renamed in intent** to "host is mac"; `SYMBOL`/`formatCombo`/`comboFromEvent` stop reading it directly and read the resolved scheme instead. `native` reproduces the exact pre-change branches, satisfying the "no regression" requirement.

- *Alternative — branch inline in each function:* duplicative and easy to drift; a single resolver keeps the three surfaces consistent.

### D3 — Store style in `uiPrefs` (with `keymapStylePrev`, `keymapStyleChosen`)
Add `keymapStyle`, `keymapStylePrev`, and `keymapStyleChosen` to `UIPrefs`. Reuse the existing `ff.uiPrefs` store and its live `subscribePrefs` broadcast so Settings stays uniform and the rest of the app re-renders. `shortcuts.ts` imports the getter + subscribes, caching the resolved scheme and re-notifying its own `subscribe` set so `ShortcutsModal` and combo hints refresh.

- *Alternative — a dedicated `ff.keymapStyle` store inside `shortcuts.ts`:* avoids a `shortcuts → uiPrefs` import but splits keyboard state across two stores and a second subscriber path; the unified prefs store is simpler.

### D4 — Reversibility model
On any style change, push the outgoing value into `keymapStylePrev` before writing the new `keymapStyle`. Two actions:
- **Revert to original** → set `keymapStyle = "native"` (also records previous, so it's undoable).
- **Revert to previous** → swap `keymapStyle` ↔ `keymapStylePrev`; calling it twice toggles back.

This satisfies the user's explicit "revert to original and revert to previous" requirement with one stored previous value (a single-level undo that toggles).

### D5 — Live re-registration of Monaco editor bindings
`FileView.tsx` binds custom commands in an effect that calls `toKeybinding(comboFor(id))`. Add the active style to that effect's dependencies (via a `useSyncExternalStore`/subscriber hook) so the editor disposes and re-adds commands when the style changes — matching the "editor bindings follow the scheme" scenario.

### D6 — First-run chooser
New `src/components/KeymapStyleModal.tsx`, mounted in `App.tsx` gated on `!prefs.keymapStyleChosen`. "Fresh install" = absence of the `ff.uiPrefs` localStorage key at startup; upgraders (key present, no choice) get `keymapStyleChosen` set `true` during a one-time migration so they are never interrupted but still see the Settings control. The modal offers Native vs the OS-appropriate alternative with a small live preview (reusing `formatCombo` against a couple of representative actions) and a shared style picker reused by Settings.

## Risks / Trade-offs

- **Monaco built-in keys stay on the platform modifier** → Under mac-on-Linux, copy/paste/undo inside the editor still respond to physical Ctrl, not Alt, until/unless we override the common set. *Mitigation:* override the small common set (`KeyMod.WinCtrl` for those under the swap) and document the remainder as a known limitation; native users are unaffected.
- **OS grabs Alt / Super** → Some Linux WMs use Alt for menu mnemonics or Super for global shortcuts. *Mitigation:* the swap relies on Alt (rarely globally grabbed) rather than Super; the global handler uses capture-phase `preventDefault` as it already does. Document that WM-level conflicts are out of scope.
- **Stale rendered hints** → Tooltip strings built with `formatCombo` at render time must refresh on style change. *Mitigation:* the prefs broadcast forces re-render of mounted views; the handful of title strings recompute on next render.
- **AltGr on some layouts emits Ctrl+Alt** → On a few EU layouts, right-Alt sets both modifiers. *Mitigation:* under the swap this yields `Mod+Alt`, an acceptable, documented edge; users can rebind. Out of scope to special-case AltGr.
- **Two stores subscribed** (D3 import) → minor coupling `shortcuts.ts → uiPrefs.ts`. *Mitigation:* one-directional import, no cycle (uiPrefs does not import shortcuts).

## Migration Plan

1. Add the three prefs with defaults (`keymapStyle: "native"`, `keymapStylePrev: "native"`, `keymapStyleChosen: false`) and a startup migration: if `ff.uiPrefs` already existed before this version, set `keymapStyleChosen: true` (don't prompt upgraders).
2. Land the scheme resolver + rewire `shortcuts.ts` and `toKeybinding` with `native` byte-equivalent — ship safely with the feature effectively dormant.
3. Add the Settings control and first-run modal.
4. Rollback: the feature is inert while `keymapStyle === "native"`; a user can always choose "Revert to original" to return to native, and uninstalling the prefs key resets everything.

## Open Questions

- Should the optional Monaco built-in remap (copy/paste/cut/undo/redo/select-all) ship in v1 or as a follow-up? Default plan: include it behind the same scheme so mac-on-Linux feels complete.
- Wording of the two revert actions in the UI ("Revert to original" vs "Reset to system default"; "Revert to previous" vs "Undo last change") — finalize during implementation.

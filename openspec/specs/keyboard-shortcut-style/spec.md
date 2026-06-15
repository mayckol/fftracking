# keyboard-shortcut-style

## Requirements

### Requirement: Keymap style preference
The system SHALL expose a persisted keymap style with exactly three values: `native`, `mac`, and `pc`. `native` SHALL preserve the pre-change behavior (scheme follows the host OS). `mac` and `pc` SHALL force their respective scheme regardless of the host OS. The default for a user who has never chosen SHALL be `native`. The style SHALL persist across restarts.

#### Scenario: Default is native
- **WHEN** the app starts and no keymap style has ever been chosen
- **THEN** the active style is `native` and shortcuts behave exactly as before this change

#### Scenario: Persisted across restart
- **WHEN** the user sets the style to `mac` and relaunches the app
- **THEN** the active style is still `mac`

### Requirement: OS-aware modifier scheme
The active style SHALL resolve to a concrete modifier scheme that depends on both the chosen style and the host OS. The scheme SHALL define, for the global key handler and for the Monaco editor, which physical modifier produces the logical `Mod` and which produces the logical `Alt`, plus the rendering symbols and separator. Canonical combo strings (`Mod+S`, `Alt+D`, `Mod+Alt+R`, …) and the action registry SHALL NOT change — only the physical-to-logical mapping and rendering change.

#### Scenario: pc scheme
- **WHEN** the effective scheme is `pc` (style `pc`, or `native` off macOS)
- **THEN** physical Ctrl produces `Mod`, physical Alt produces `Alt`, and combos render as `Ctrl`/`Alt`/`Shift` joined with `+`

#### Scenario: mac scheme on macOS host
- **WHEN** the effective scheme is `mac` and the host is macOS (including `native` on macOS)
- **THEN** physical ⌘ produces `Mod`, physical ⌥ produces `Alt`, and combos render as ⌘/⌥/⇧ joined with spaces

#### Scenario: mac scheme on a non-mac host (the Alt↔Ctrl swap)
- **WHEN** the effective scheme is `mac` and the host is Linux or Windows
- **THEN** the physical **Alt** key (next to the spacebar) produces `Mod`, the physical **Ctrl** key produces `Alt` (Option), and combos render as ⌘/⌥/⇧ joined with spaces

#### Scenario: Existing bindings keep working under the swap
- **WHEN** a Linux user in `mac` style presses the physical Alt key plus `S`
- **THEN** the `Mod+S` action (Save file) fires; and pressing physical Ctrl plus `D` fires the `Alt+D` action (Delete line) — with no rebinding required

### Requirement: Consistent application across handler, rendering, and editor
The resolved scheme SHALL be applied in all three shortcut surfaces: the global `keydown` matcher, every place that renders a combo for display, and the Monaco editor command bindings. Switching the style SHALL update all three live, without an app reload.

#### Scenario: Global matcher follows the scheme
- **WHEN** the style changes while the app is running
- **THEN** subsequent key presses are matched using the new scheme immediately

#### Scenario: Rendered combos follow the scheme
- **WHEN** the style changes
- **THEN** shortcut hints in tooltips, the Settings shortcuts view, and the shortcuts modal render using the new scheme's symbols and separator

#### Scenario: Editor bindings follow the scheme
- **WHEN** the style changes while a file is open in the editor
- **THEN** the editor's custom command keybindings (e.g. Format document, Save) are re-registered so they respond to the new scheme's physical keys without reopening the file

### Requirement: First-run keymap chooser
On a fresh install (no prior app preferences), the app SHALL present a one-time first-run chooser offering the OS-native scheme and the cross-platform alternative, each with a short label and a preview of representative shortcuts. Confirming a choice SHALL persist the style, mark the choice as made, and dismiss the chooser. Upgrading users who already have preferences SHALL NOT be interrupted; they SHALL remain on `native` and find the control in Settings.

#### Scenario: Shown once on fresh install
- **WHEN** the app launches for the first time with no stored preferences
- **THEN** the first-run keymap chooser is displayed before normal use

#### Scenario: Not shown again after choosing
- **WHEN** the user has confirmed a keymap choice (or dismissed the chooser) once
- **THEN** the chooser does not appear on subsequent launches

#### Scenario: Upgrading user is not interrupted
- **WHEN** the app launches with pre-existing preferences but no recorded keymap choice
- **THEN** the chooser is not shown, the active style is `native`, and the option is available in Settings

#### Scenario: Symmetric options per OS
- **WHEN** the chooser is shown on Linux or Windows
- **THEN** it offers "Native" and "macOS style"; on macOS it offers "Native" and "Windows/Linux style"

### Requirement: Settings control
Settings → Shortcuts SHALL present a control to view and change the keymap style at any time, reflecting the current value and applying changes live. The control SHALL be available on every OS.

#### Scenario: Change from Settings
- **WHEN** the user selects a different keymap style in Settings
- **THEN** the style is applied live and persisted, and the control shows the new value

### Requirement: Revert to original and revert to previous
The system SHALL remember the previously active style whenever the style changes, and SHALL offer two distinct revert actions. **Revert to original** SHALL set the style back to the OS-native default (`native`). **Revert to previous** SHALL swap the current and previously active styles so the last change can be undone. Both actions SHALL apply live and persist, and SHALL themselves update the remembered previous style so they are also reversible.

#### Scenario: Revert to original
- **WHEN** the user is on `mac` (or `pc`) style and chooses "Revert to original"
- **THEN** the active style becomes `native` and the previous value is recorded so it can be restored

#### Scenario: Revert to previous undoes the last change
- **WHEN** the user changed the style from `native` to `mac` and then chooses "Revert to previous"
- **THEN** the active style returns to `native`

#### Scenario: Revert to previous is itself reversible
- **WHEN** the user chooses "Revert to previous" a second time
- **THEN** the style returns to the value it had before the first revert (the two styles toggle)

### Requirement: Native behavior is unchanged
For style `native`, event matching, combo rendering, and editor bindings SHALL be byte-for-byte equivalent to the pre-change behavior on every OS, so users who never opt in see no difference.

#### Scenario: No regression for native users
- **WHEN** a user never touches the keymap style on any OS
- **THEN** all shortcuts, symbols, and editor bindings behave exactly as they did before this change

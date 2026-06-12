# file-icon-packs

## ADDED Requirements

### Requirement: Icon pack provider interface
The system SHALL resolve all file and folder icons through an icon pack interface that, given a file name, returns a file icon, and given a folder name plus open/closed state, returns a folder icon. Icon packs SHALL be registered in a central registry and identified by a stable id.

#### Scenario: Active pack resolves icons
- **WHEN** a tree view renders a file node while the "material" pack is active
- **THEN** the icon comes from the Material pack's resolution rules, not from hard-coded per-call-site logic

#### Scenario: Unknown pack id falls back
- **WHEN** preferences reference an icon pack id that is not registered
- **THEN** the system uses the default pack and does not crash

### Requirement: Material Icons pack
The system SHALL ship a Material Icons pack (material-icon-theme set) that matches icons by exact well-known filename first (e.g., `package.json`, `Dockerfile`), then by file extension (longest compound extension wins, e.g., `.test.ts` before `.ts`), and falls back to a generic file icon when nothing matches. Folder icons SHALL match well-known folder names (e.g., `src`, `node_modules`) with distinct open and closed variants, falling back to generic folder icons.

#### Scenario: Extension match
- **WHEN** a file named `main.rs` is rendered
- **THEN** the Rust icon from the Material set is shown

#### Scenario: Filename overrides extension
- **WHEN** a file named `package.json` is rendered
- **THEN** the npm/package icon is shown rather than the generic JSON icon

#### Scenario: No match
- **WHEN** a file with an unmapped extension is rendered
- **THEN** the Material generic file icon is shown

#### Scenario: Known folder open state
- **WHEN** a folder named `src` is expanded
- **THEN** the Material `src` open-folder variant is shown

### Requirement: Built-in pack preserved
The system SHALL keep the existing hand-rolled icons available as a "builtin" pack so the pre-change appearance remains selectable.

#### Scenario: Builtin selected
- **WHEN** the user selects the builtin pack
- **THEN** trees render the original folder/file/Go icons exactly as before this change

### Requirement: Icon pack selection
The system SHALL let the user pick the active icon pack in Settings, persist the choice in UI preferences, and apply it to all open views immediately without reload. The default pack SHALL be "material".

#### Scenario: Live switch
- **WHEN** the user changes the icon pack in Settings
- **THEN** project tree, changed-files tree, tabs, and search results re-render with the new pack's icons without app restart

#### Scenario: Persistence
- **WHEN** the user restarts the app after selecting a pack
- **THEN** the selected pack is active on startup

### Requirement: Icon rendering surfaces
All file/folder icon call sites — project tree, changed-files tree, editor tabs, and search palette results — SHALL render icons via the active pack.

#### Scenario: Consistent icons across surfaces
- **WHEN** the same file appears in the project tree and in search results
- **THEN** both show the identical icon from the active pack

# ui-theming

## ADDED Requirements

### Requirement: Declarative theme definitions
A theme SHALL be a declarative token object containing: id, label, appearance (dark/light), a complete set of values for every CSS custom property the app declares in `:root` (surfaces, hairlines, text, accent, status, trigger hues, glows), and Monaco editor colors plus syntax token rules. Themes SHALL be registered in a central registry.

#### Scenario: Complete token coverage
- **WHEN** a theme is registered
- **THEN** it provides a value for every themable CSS variable, so no panel retains a stale color after switching

### Requirement: Theme application
Applying a theme SHALL set all theme CSS variables on the document root and define/activate a matching Monaco editor theme, affecting all open editors. The active theme SHALL be applied at startup before first paint and re-applied live when the preference changes.

#### Scenario: Live switch
- **WHEN** the user selects a different theme in Settings
- **THEN** panels, chrome, and all open Monaco editors (file view and diff view) update colors immediately without reload

#### Scenario: Startup application
- **WHEN** the app starts with a persisted theme selection
- **THEN** the UI first renders already in that theme

#### Scenario: Unknown theme id
- **WHEN** preferences reference an unregistered theme id
- **THEN** the system applies the default theme and does not crash

### Requirement: Tokyo Night default theme
The system SHALL ship a "Tokyo Night" theme derived from the Tokyo Night dark palette (Zed theme variant: background `#1a1b26`, text `#a9b1d6`/`#c0caf5`, keyword `#bb9af7`, string `#9ece6a`, constants `#ff9e64`, types `#0db9d7`, functions `#7aa2f7`, comments `#51597d`, status colors created `#9ece6a` / modified `#e0af68` / deleted `#f7768e`). Tokyo Night SHALL be the default theme for new and upgrading users who have not explicitly chosen a theme.

#### Scenario: Default on fresh install
- **WHEN** the app starts with no stored theme preference
- **THEN** Tokyo Night is active

#### Scenario: Syntax colors
- **WHEN** a Go or Rust file is opened under Tokyo Night
- **THEN** keywords render purple (`#bb9af7`), strings green (`#9ece6a`), and the editor background is `#1a1b26`

### Requirement: FFTrack Dark preserved
The current visual design SHALL remain available as a registered "FFTrack Dark" theme whose tokens equal the pre-change `:root` values and Monaco theme.

#### Scenario: Selecting FFTrack Dark
- **WHEN** the user selects FFTrack Dark
- **THEN** the app renders identically to its pre-change appearance

### Requirement: Theme selection persistence
The system SHALL let the user pick the theme in Settings and persist the choice in UI preferences across restarts.

#### Scenario: Persistence
- **WHEN** the user selects FFTrack Dark and restarts the app
- **THEN** FFTrack Dark is active on startup

# Add Material Icons and Theming

## Why

The app's visual identity is hard-coded: file/folder icons are three hand-rolled SVGs in `src/components/Icons.tsx` (everything except `.go` files gets a generic icon), and colors live as fixed CSS variables in `src/styles.css` plus a fixed Monaco theme in `src/components/monacoTheme.ts`. There is no way to recognize file types at a glance in the project tree, and no way to change the app's look without editing source.

## What Changes

- Add a **file icon provider system** that works like a plugin: icon packs are self-contained modules behind a common interface, the active pack is selectable in Settings, and Material Icons (material-icon-theme, the VSCode-style set) ships as the first pack alongside the existing built-in icons as fallback.
- Project tree, changed-files tree, tabs, and search results render per-file-type icons (by extension and well-known filenames) and folder icons (open/closed, well-known folder names) from the active pack.
- Add a **theme system**: a theme is a declarative token set (UI surface colors, text, accents, status colors, syntax colors) that maps onto the existing CSS variables and generates the Monaco editor theme. Themes are registered as plugins and selectable in Settings.
- Create a **Tokyo Night theme** derived from the provided Zed theme JSON (Tokyo Night dark variant as base) and apply it as the default theme.
- Preserve the current look as a built-in "FFTrack Dark" theme so the existing design remains available.
- Persist icon pack and theme selections in UI preferences (`uiPrefs`), applied live without reload.

## Capabilities

### New Capabilities
- `file-icon-packs`: pluggable file/folder icon providers; Material Icons pack; selection and rendering rules (extension, filename, folder-name matching, fallbacks).
- `ui-theming`: pluggable theme definitions (UI tokens + Monaco syntax colors); theme selection and live application; Tokyo Night as default theme; FFTrack Dark as preserved built-in.

### Modified Capabilities

None — no existing specs.

## Impact

- `src/components/Icons.tsx`, `src/panels/ProjectTree.tsx`, `src/panels/ChangedTree.tsx`, search/tab components — icon rendering goes through the provider.
- `src/styles.css` — `:root` color tokens become theme-driven (set via JS on document root); structural CSS unchanged.
- `src/components/monacoTheme.ts` — Monaco theme generated from active theme tokens instead of fixed values.
- `src/lib/uiPrefs.ts`, `src/panels/SettingsView.tsx` — new `iconPack` and `theme` prefs plus pickers.
- New dependency: `material-icon-theme` (icon SVGs) or vendored subset under `assets/`.

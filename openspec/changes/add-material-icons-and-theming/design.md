# Design — Material Icons and Theming

## Context

Visual identity is fixed at three points:

- `src/components/Icons.tsx`: three hand-rolled SVG components (`FolderIcon`, `FileIcon`, `GoIcon`). `ProjectTree.tsx` special-cases `.go`; everything else gets the generic file icon.
- `src/styles.css`: all colors are CSS custom properties declared once in `:root` (`--bg-*`, `--tx-*`, `--ac*`, status colors, trigger hues). Structural CSS consumes only the variables — this is the seam the theme system exploits.
- `src/components/monacoTheme.ts`: one hard-coded Monaco theme (`fftrack-dark`) with literal hex values; `defineTheme` is called once per Monaco instance.

Preferences already have a working pattern: `src/lib/uiPrefs.ts` persists to localStorage, broadcasts to subscribers, and `SettingsView.tsx` renders pickers. New prefs slot in with zero new infrastructure.

## Goals / Non-Goals

**Goals:**
- Per-file-type icons (Material Icons set) in tree views, tabs, and search results, behind a provider interface so more packs can be added later.
- Declarative theme objects that drive both the CSS variables and the Monaco editor theme.
- Tokyo Night (dark variant from the provided Zed JSON) as default theme; current design preserved as selectable "FFTrack Dark".
- Live switching for both icon pack and theme, persisted via `uiPrefs`.

**Non-Goals:**
- Loading third-party theme/icon packs from disk at runtime (plugins are compile-time registered modules; the *interface* is pluggable, not the distribution).
- Light-appearance support work beyond what falls out naturally (Tokyo Night Light variant can be added later as another registered theme).
- Theming the terminal (xterm) and DAP/debug colors beyond mapping the existing CSS variables they already use.
- A theme editor UI.

## Decisions

### D1 — Icon pack as provider interface, Material via `material-icon-theme` npm package

```ts
// src/lib/iconPacks/types.ts
export interface IconPack {
  id: string;            // "material" | "builtin"
  label: string;
  fileIcon(name: string): IconRef;            // match by filename, then extension
  folderIcon(name: string, open: boolean): IconRef;
}
type IconRef = { kind: "svg-url"; url: string } | { kind: "component"; Component: React.FC };
```

- **Material pack**: depend on `material-icon-theme` (the VSCode set, MIT, ~900 SVGs under `node_modules/material-icon-theme/icons`). Name resolution via the package's `generateManifest()` API — returns the full mapping (fileExtensions, special fileNames like `package.json`/`Dockerfile`, folderNames with open variants, language ids), so matching logic is maintained upstream, not hand-built. SVG URLs resolved with Vite `import.meta.glob("…/icons/*.svg", { query: "?url", eager: false })` so only used icons are fetched. Rendered as `<img>` with fixed 16px box — SVGs are pre-colored, no CSS recolor needed.
- **Builtin pack**: wraps the existing `Icons.tsx` components, returned as `kind: "component"`. Guarantees the no-dependency fallback and keeps current behavior available.
- A single `<FileTypeIcon name={...} />` / `<FolderTypeIcon name={...} open />` component reads the active pack from prefs and renders the right `IconRef`; call sites (`ProjectTree`, `ChangedTree`, tabs, `SearchPalette`) swap their direct `Icons.tsx` usage for it.
- *Alternative considered*: vendoring a curated SVG subset under `assets/`. Rejected — mapping tables are the hard part and the package maintains them; vendoring means manual upkeep.

### D2 — Theme as token object keyed by the existing CSS variables

```ts
// src/lib/themes/types.ts
export interface Theme {
  id: string;            // "tokyo-night" | "fftrack-dark"
  label: string;
  appearance: "dark" | "light";
  cssVars: Record<string, string>;   // "--bg-0": "#1a1b26", ... full set required
  monaco: { rules: TokenRule[]; colors: Record<string, string> };
}
```

- Applying a theme = write every `cssVars` entry onto `document.documentElement.style` + re-`defineTheme` and `setTheme` on Monaco. No CSS rewrite: `styles.css` keeps its `:root` block as the FFTrack Dark fallback values.
- `monacoTheme.ts` becomes a generator: `defineThemeFor(monaco, theme)` builds the Monaco theme from `theme.monaco` (one Monaco theme name per app theme id, so switching is `editor.setTheme(id)`).
- Themes registered in `src/lib/themes/index.ts` registry; Settings picker iterates the registry.
- *Alternative considered*: swapping `<link>` stylesheets per theme. Rejected — duplicates 2400 lines of structural CSS per theme; token substitution is the entire delta between themes.

### D3 — Tokyo Night mapping from the Zed JSON

The Zed "Tokyo Night" dark variant maps onto the app tokens:

| App token | Zed source | Value |
|---|---|---|
| `--bg-0` | `background` | `#1a1b26` |
| `--bg-1` | `surface.background` | `#16161e` |
| `--bg-2..4` | `elevated_surface` + element states | `#1e202e`, `#202330`, `#414868` ramp |
| `--line`/`--line-2` | `border` / `border.focused` base | `#101014`, `#363b54` |
| `--tx-0..3` | `text`, `text.muted`, `hint`, `text.disabled` | `#c0caf5`/`#a9b1d6`, `#787c99`, `#51597d`, `#414868` |
| `--ac` | syntax `function` / accent blue | `#7aa2f7` |
| `--add`/`--mod`/`--del` | `created`/`modified`/`deleted` | `#9ece6a`, `#e0af68`, `#f7768e` |
| `--conflict` | `conflict` | `#bb9af7` (purple — Tokyo Night's conflict hue) |
| Monaco syntax | `syntax` block | keyword `#bb9af7`, string `#9ece6a`, number/const `#ff9e64`, comment `#51597d`, type `#0db9d7`, function `#7aa2f7`, etc. |

Diff/selection Monaco colors come from `created`/`deleted` with the same alpha treatment the current theme uses. Exact full table lives in the theme module, not here.

### D4 — Preferences and defaults

- Extend `UIPrefs`: `iconPack: string` (default `"material"`), `theme: string` (default `"tokyo-night"`). Existing merge-with-DEFAULTS load means current users get the new defaults on upgrade — which satisfies "apply Tokyo Night as default".
- Theme application runs at startup (before first paint, in `main.tsx`) and on pref change via the existing `uiPrefs` subscription; unknown ids fall back to defaults.
- The hard-coded ruler colors in `editorPrefOptions` (`#1c2430`, `#283344`) move into theme tokens — they're the only theme-relevant literals outside the three files above found so far; implementation includes an audit pass for stragglers.

## Risks / Trade-offs

- [Monaco instances cache the theme; `setTheme` is global per Monaco namespace] → define all registered themes up front in `onMount`, switching is then a single `setTheme` call that affects all editors at once.
- [`material-icon-theme` ships hundreds of SVGs, bundle bloat risk] → lazy `import.meta.glob` keeps them out of the main bundle; Tauri serves them as local assets, no network.
- [Tokyo Night contrast differs from current design (lighter bg, softer hairlines); some hard-coded rgba glows in `body` background-image won't match] → those two radial-gradient glows become theme tokens too (`--glow-1`, `--glow-2`); acceptance check is visual on every panel.
- [Zed token names don't 1:1 match app tokens; mapping is judgment] → mapping table reviewed in D3; FFTrack Dark stays one click away if Tokyo Night mapping disappoints.

## Open Questions

- None blocking. Tokyo Night Storm/Moon/Light variants are trivial follow-ups once the dark variant lands (same Zed JSON, new token tables).

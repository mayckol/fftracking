# Tasks — Material Icons and Theming

## 1. Theme system core

- [x] 1.1 Create `src/lib/themes/types.ts` with the `Theme` interface (id, label, appearance, cssVars covering every `:root` token in `styles.css`, monaco rules + colors)
- [x] 1.2 Create `src/lib/themes/fftrackDark.ts` capturing the current `:root` values and current `monacoTheme.ts` values verbatim
- [x] 1.3 Create `src/lib/themes/tokyoNight.ts` from the Zed Tokyo Night dark variant per the design D3 mapping table (UI tokens + Monaco syntax rules + diff colors)
- [x] 1.4 Create `src/lib/themes/index.ts` registry with lookup by id and default fallback (`tokyo-night`)
- [x] 1.5 Implement `applyTheme(theme)`: write cssVars onto `document.documentElement.style`; move the body radial-gradient glows and `editorPrefOptions` ruler colors into theme tokens

## 2. Monaco integration

- [x] 2.1 Rework `src/components/monacoTheme.ts` into `defineThemeFor(monaco, theme)` generating one Monaco theme per registered theme; define all registered themes in editor `onMount`
- [x] 2.2 Switch `FileView.tsx` and `DiffEditor.tsx` to use the active theme's Monaco theme id and react to theme pref changes via `setTheme`

## 3. Theme preference and startup

- [x] 3.1 Add `theme: string` to `UIPrefs` (default `"tokyo-night"`) in `src/lib/uiPrefs.ts`
- [x] 3.2 Apply the active theme at startup in `main.tsx` before first render and subscribe to pref changes for live re-apply
- [x] 3.3 Add theme picker to `SettingsView.tsx` iterating the theme registry
- [x] 3.4 Audit `styles.css` and TSX for theme-relevant hard-coded hex/rgba values outside `:root`; route stragglers through CSS variables

## 4. Icon pack core

- [x] 4.1 Add `material-icon-theme` dependency
- [x] 4.2 Create `src/lib/iconPacks/types.ts` (`IconPack` interface, `IconRef` union) and `src/lib/iconPacks/index.ts` registry with default fallback (`material`)
- [x] 4.3 Create `src/lib/iconPacks/builtin.tsx` wrapping existing `Icons.tsx` components
- [x] 4.4 Create `src/lib/iconPacks/material.ts`: lazy SVG loading via `import.meta.glob`, name resolution through `generateManifest()` (fileNames/fileExtensions/folderNames incl. compound extensions) with generic fallbacks

## 5. Icon rendering

- [x] 5.1 Create `<FileTypeIcon>` / `<FolderTypeIcon>` components reading the active pack from prefs (16px box, img for svg-url refs, component refs rendered directly)
- [x] 5.2 Replace direct icon usage in `ProjectTree.tsx` (including the `.go` special case) with the new components
- [x] 5.3 Replace icon usage in `ChangedTree.tsx`, editor tabs, and `SearchPalette.tsx`

## 6. Icon preference

- [x] 6.1 Add `iconPack: string` to `UIPrefs` (default `"material"`)
- [x] 6.2 Add icon pack picker to `SettingsView.tsx`

## 7. Verification

- [x] 7.1 `npm run build` passes (tsc + vite)
- [ ] 7.2 Manual pass per specs: live theme switch across panels + both editors, startup theme, FFTrack Dark pixel-equivalence, icon matching scenarios (`main.rs`, `package.json`, unmapped extension, `src` folder open/closed), icon consistency across tree/tabs/search
- [x] 7.3 Verify localStorage persistence of both prefs across restart and fallback behavior for unknown ids

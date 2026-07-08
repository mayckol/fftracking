# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [1.1.1] — 2026-07-08

### Fixed

- **MCR reliably opens when spawned from the app — and says why when it can't.**
  On Linux the raw MCR AppImage needs libfuse2 to mount; on distros without it
  the child died instantly and invisibly (MCR's own shell wrappers handle this,
  but the app execs the image directly). The app now prefers MCR's pre-extracted
  AppDir (`~/.local/libexec/mcr/squashfs-root/AppRun`, installed by MCR ≥
  0.3.6), sets `APPIMAGE_EXTRACT_AND_RUN=1` itself when falling back to the raw
  image on a FUSE-less system, scrubs more AppImage-injected variables
  (GIO/GST/WebKit module paths) and filters fftracking-mount entries out of
  `PATH`/`XDG_DATA_DIRS`. MCR's stderr is now captured: if it exits non-zero
  with output (or dies within seconds), the error surfaces as a toast instead
  of nothing happening.
- **Opening MCR no longer stalls the UI.** The merge/diff commands run off the
  main thread, so reconstructing conflict sides on a big repository cannot
  freeze the window.

## [1.1.0] — 2026-07-07

### Fixed

- **MCR now actually launches from the Linux app for merge conflicts and git
  compare.** fftracking ships as an AppImage, whose runtime injects `APPDIR`,
  `APPIMAGE`, a prepended `LD_LIBRARY_PATH`, and GTK/GDK/GST plugin paths that
  point into fftracking's own mount. A spawned MCR AppImage inherited them, so
  its AppRun mis-detected an already-mounted image and loaded fftracking's
  libraries instead of its own — dying before showing a window. MCR is now
  spawned with those AppImage-injected variables stripped, so it bootstraps
  cleanly. This is the missing piece behind the 1.0.28 fix, which switched to
  the raw AppImage but never sanitized the inherited environment.

## [1.0.28] — 2026-07-06

### Fixed

- **MCR now opens correctly on Linux for merge conflicts and git compare.** The
  Linux `mcr` on PATH is a launcher wrapper that reinterprets argv (dropping the
  extra files of the 4-way merge signature) and chdir's the AppImage into its own
  mount, losing the caller's working directory. fftracking now invokes the raw
  `mcr.AppImage` directly — as macOS already does with the raw `.app` binary — and
  passes the repository as an explicit anchor for compare, since the AppImage
  destroys the cwd it would otherwise discover the repo from.

## [1.0.27] — 2026-07-03

### Changed

- **Merge conflicts and git compare now open in [MCR](https://github.com/mayckol/mcr),
  a dedicated external merge/diff app.** Clicking a conflicted file (or "Merge…" in the
  conflicts dialog) launches MCR on that file following the git mergetool contract; on
  Save & Exit the file is staged and the conflicts list refreshes automatically. The Git
  view's compare pane and History's "Compare with…" open MCR's whole-repo diff (chosen
  ref against the working tree, with a file sidebar). If MCR isn't installed, a toast
  points at the installer. Bulk Accept Yours/Theirs, staging, committing, and the
  breaking-point Revert file/folder actions all remain in-app.

### Removed

- **The built-in 3-way merge editor and inline Monaco diff viewer.** Both are replaced
  by MCR; the app sheds the whole in-app diff3/merge engine (~3,200 lines).

## [1.0.26] — 2026-06-30

### Fixed

- **Reopening or splitting a file no longer shows stale content after an external write.**
  Monaco keeps one model per path, so reopening a file — or opening it in a second pane —
  could reuse a model that predated a write from an AI agent or the terminal. The saved
  baseline now persists per path, so a remount can tell a clean-but-stale model (adopt the
  new disk content) from one carrying real unsaved edits (preserve them), reconciling on
  mount before the change listener is wired.

## [1.0.25] — 2026-06-26

### Changed

- **The 3-way merge editor was rebuilt from the ground up to match JetBrains.** A single
  toolbar (jump between changes, apply non-conflicting changes Left / All / Right, a
  magic wand to auto-resolve the simple ones), three locked headers naming each side's
  branch, in-gutter accept (» / «), reject (✕) and keep-both (↓) buttons on every change,
  change connectors between the panes, and a change-bar minimap on the result scrollbar
  with conflicts in red. The result pane stays fully editable — typing and click-to-accept
  coexist under one unified undo.
- **The conflicts list shows what you're in the middle of.** The header now spells out the
  operation (merging / rebasing / cherry-picking / reverting), the branches involved, and
  the commit being replayed (author and message), and each file carries its type icon.

### Fixed

- **No more silent data loss while resolving conflicts.** Resolving a modify/delete conflict
  to an empty result now removes the file instead of leaving it empty; one-sided deletions,
  hand edits in unchanged regions, and accepting a whole side no longer drift onto or
  overwrite a neighbouring change.

## [1.0.24] — 2026-06-25

### Changed

- **The 3-way merge editor now lines up like JetBrains.** Matching lines sit on the
  same row across all three panes — a change that is longer on one side gets a tinted
  gap on the shorter sides instead of letting the rest of the file drift out of
  alignment. The mouse wheel scrolls all three panes together, and a taller pane (or
  one with longer lines) keeps scrolling on its own once the others reach their edge;
  horizontal scrolling is synced too.
- **Cleaner merge chrome.** Change highlights are one flat, even colour across the line
  numbers and the code (no more two-tone band), the gutter connectors no longer paint
  over the pane labels, and the panes share one seamless background with the dividing
  borders removed.

## [1.0.23] — 2026-06-24

### Added

- **Redis cache plugin (opt-in).** A lightweight Redis client: browse keys in a
  colon-grouped namespace tree, inspect every type, edit string values with a
  formatted JSON view, set or clear TTLs, and create, rename, or delete keys
  (right-click a key for rename/delete). A console runs raw commands. Disabled by
  default — enable it from the Plugins tab. Connections are saved locally and
  passwords are stored in the OS keychain, with a prompt-on-connect fallback where
  no keychain is available.
- **Clickable links in the terminal.** http(s) URLs printed in the terminal are now
  detected and open in your web browser on click.

## [1.0.22] — 2026-06-23

### Added

- **Apply a block from a two-revision compare into your working tree.** Comparing
  two branches or commits used to be read-only. Now each change shows an apply
  arrow that splices just that block's version into your working file, leaving the
  rest untouched. If your working copy has diverged in that block, it reports a
  clear error instead of touching the file.
- **Per-pane revision labels.** Diffs now label each pane with the branch, commit
  or "working tree" it shows, with a small direction badge on the split. The 3-way
  merge editor uses the same labelled treatment.
- **Land on the first change.** Opening the Git view selects the first changed
  file, and clicking any file jumps to and highlights its first change. Navigating
  between changes highlights the one you land on.

### Changed

- **The Git view is preserved when you switch tabs** — the open file and its diff
  scroll position survive a trip to Files and back.

### Fixed

- **No more "Cannot edit in read-only editor".** Applying a change from a read-only
  compare now writes to the working tree through the backend instead of trying to
  edit the read-only pane.
- **The apply arrow lines up with its change** (deletions no longer push it a row
  below).

## [1.0.21] — 2026-06-23

### Changed

- **App shortcuts work while the terminal is focused.** A focused terminal used to
  swallow every keyboard shortcut except the terminal toggle. Now app-level
  navigation, search and file-management shortcuts (focus file in tree, switch
  tabs, toggle panels, find files) still fire from the terminal, while the shell
  keeps its own clipboard chords and control keys (Ctrl-C, Ctrl-R, …).

### Fixed

- **Scrollbar change markers stay visible with the terminal open.** The git
  add/modified/deleted stripes in the editor's right scrollbar used to disappear
  when the terminal or run dock opened and resized the editor. They are now
  repainted on layout changes, so they persist through the resize.

## [1.0.20] — 2026-06-23

### Added

- **Alt+C / Alt+V diff shortcuts.** Apply or revert the change at the cursor in
  any diff editor (commit mode, compare-vs-working, branch compare) without
  reaching for the glyph. Both keys perform the same block-apply operation
  (pull the reference version into the working tree).
- **Git change markers in the editor scrollbar.** The main code editor now shows
  colored stripes in the right-side overview ruler for added/modified/deleted
  lines, matching JetBrains IDEs.
- **"Files are identical" placeholder in diff views.** When a diff has no changes,
  a centered label appears to confirm the two sides match, instead of an empty
  diff pane.

### Fixed

- **External file edits no longer get stuck as stale + dirty.** When a file is
  edited in a terminal (or by an external tool), the app was permanently blocking
  reloads if the dirty flag had stuck. Now the reconcile logic checks whether
  unsaved user edits exist; clean buffers always reload from disk, preserving
  the blue dot only when you have real unsaved changes. Fixes the issue on both
  Linux and macOS.

## [1.0.19] — 2026-06-22

### Added

- **Filter the changes list.** A search box above the commit and compare file
  lists filters staged, changed and unversioned files by name or path as you
  type.
- **Discard a whole folder.** Right-click a folder in the changes tree to discard
  every change beneath it (restore to HEAD) in one action.

### Changed

- **Single apply arrow in the diff gutter.** The per-change gutter control is now
  a quiet right arrow (→) that pushes the selected version into the working tree,
  replacing the filled revert chip. Monaco's own gutter menu is turned off so
  there's exactly one affordance.
- **Cyclic change navigation.** Pressing ↑/↓ past the last change now wraps to the
  first file (and vice-versa) instead of stopping at the edge of the list.

### Fixed

- **Git view tracks external changes.** A checkout, commit or edit made from a
  terminal (or an AI agent) now refreshes the git view — open diffs, the file
  list, current branch and merge state — on window refocus and on the backend's
  filesystem signals, instead of leaving stale diff tabs open.

## [1.0.18] — 2026-06-22

### Added

- **Folder tree in the commit view.** Staged and unstaged files now group into a
  collapsible folder tree instead of a flat list of long paths, mirroring the
  compare view. Each file keeps its stage/unstage button, and folders gain one
  too — stage or unstage everything beneath a folder in a single click.
- **Unversioned files split out.** New, untracked files now sit in their own
  "Unversioned" section, separate from edits to already-tracked files, so it's
  clear at a glance what git is and isn't following yet.

### Fixed

- **Steady diff toolbar.** The diff header's buttons (navigate, undo/redo, stage,
  open, layout) used to slide left or right depending on how long the file name
  was. The name and revision label now share the left side and truncate as
  needed, while the buttons stay pinned to a fixed spot on the right.

## [1.0.17] — 2026-06-22

### Fixed

- **Paste into the Find box.** With the find/replace widget focused, paste
  (⌘V / Ctrl+V, or Alt+V under the Linux macOS-style keymap) went into the
  document at the cursor and refocused the editor instead of the search field.
  The editor's clipboard commands are now scoped to the code area, and under
  mac-emulation copy/paste reach the widget input through the clipboard plugin.

### Changed

- **Language-server memory.** A `gopls` ran per project root and was never
  stopped, so switching across projects stacked one process per project (each
  loading its own module graph — several GB in total). Each `gopls` now caps its
  heap via `GOMEMLIMIT` (default 2 GiB, override with `FFTRACKING_GOPLS_MEMLIMIT`),
  and a project's language servers are released a short while after you switch
  away from it — returning within the grace window keeps them warm.

## [1.0.16] — 2026-06-19

### Added

- **JSX & Vue highlighting.** React files get their own grammars
  (`.tsx`, `.jsx`) and Vue single-file components highlight their `<template>`,
  `<script>` and `<style>` blocks with the right language each. The vtsls
  language server now also powers `.tsx`/`.jsx`, so completion, diagnostics and
  hovers work there too.
- **Run buttons for the JS/TS ecosystem.** Run glyphs appear on `package.json`
  scripts, plain `.js`/`.sh` files and test files, launching the right tool
  (npm/pnpm/yarn/bun, or vitest/jest/mocha/node) with coloured output. Works in
  the packaged app even though it inherits a stripped PATH.

### Changed

- The Run panel resets when you switch projects, so a new project never shows
  the previous one's output.
- ANSI background colours now render in the Run panel.
- The Linux installer fronts the AppImage with a small launcher so
  `fftracking <path>` returns the shell immediately and resolves relative paths.

## [1.0.15] — 2026-06-19

### Added

- **Spell Check plugin.** Inline spell checking for EN-us and PT-br at once (a
  word is accepted if valid in either), running in a Web Worker so the editor
  stays responsive. Misspellings get a subtle squiggle with quick-fixes: replace
  with a suggestion, add the word to your dictionary, or add every flagged word
  in the file at once. Toggle it in Settings → Plugins.

### Changed

- License changed from MIT to a Coffeeware license.

## [1.0.14] — 2026-06-19

### Added

- **Open a project from the terminal.** Install the `fftrack` command (Settings →
  System) and run `fftrack ~/path/to/project` to open it, like VSCode's `code`.
  A second invocation is forwarded to the running app instead of starting a new
  one.
- **In-app updates.** A titlebar pill appears when a newer release is published;
  clicking it (or Settings → Updates) re-runs the installer in a terminal,
  detecting how the app was installed. The installer also accepts `--uninstall`
  to remove the app and CLIs.
- **Revert a file to the current branch.** Right-click in the editor →
  "Revert file to current branch" discards the file's working changes back to its
  committed (HEAD) version.
- **Move line or block up/down** with ⇧⌘↑/↓. On a foldable block header
  (function, `if`, loop) the whole block moves as a unit.

### Changed

- The terminal toggle moved from the toolbar to the footer status bar, beside the
  history toggle. Footer icons were normalized for even weight and clearer
  active/pressed states.

### Fixed

- **Comparing HEAD → working tree now lists untracked files**, matching the commit
  panel instead of reporting zero changes for a new file.

## [1.0.13] — 2026-06-18

### Changed

- **Projects are now chosen from a titlebar picker** instead of a left sidebar.
  The picker filters by name, shows a live dot on the project being tracked, and
  lets you remove a project inline; an icon button next to it adds a folder.
- **Only the selected project is monitored.** Switching projects stops the
  previous one and starts the new one, so exactly one project is tracked at a
  time. Editor-detected projects still appear in the picker but are not captured
  until you select them.

### Removed

- The monitored sidebar and its auto-hide preference.

## [1.0.12] — 2026-06-17

### Fixed

- **Project tree now tracks the filesystem live.** The directory monitor's watcher
  emits a change event that re-walks the working tree, so an external branch switch,
  `touch`, or edit (including one run in the integrated terminal) updates the tree
  without waiting for a manual reload — stale rows for files that no longer exist on
  the new branch are dropped, and newly added files appear at once.
- **New untracked, non-ignored files tint green** as soon as they appear, instead of
  only after the next status poll.
- **Opening a file that was deleted** (e.g. removed by a branch switch) shows a clear
  "This file no longer exists" placeholder instead of the misleading "binary or could
  not be read as text" message. Binary files are now detected by content rather than
  rendering as garbled text.

## [1.0.11] — 2026-06-17

### Added

- **Three-way merge editor** for resolving conflicts, opened in its own standalone
  window (drag it anywhere, even to another monitor). Ours / Result / Theirs panes
  with per-hunk accept, `↓` keep-both for differing sides, danger bands for conflicts,
  and a unified undo/redo that covers both accept decisions and manual edits.
- **Conflicts in the commit view**: a collapsible **Conflicts** section (alongside
  collapsible Staged and Changes) lists each conflicted file; the status-bar git icon
  turns danger with a count badge and opens the conflicts list. Modify/delete conflicts
  are surfaced too, and a merge started in the integrated terminal shows up within seconds.

### Changed

- Closing the merge window with unresolved conflicts warns before discarding; resolving
  every conflict shows a success state and closing then applies & stages automatically.

## [1.0.10] — 2026-06-17

### Added

- **Change all occurrences of a word** (⌘⇧A) — the word at the caret (or the current
  selection) gets a cursor on every occurrence in the file, so a single edit rewrites
  them all. Rebindable.
- **Configurable shortcuts for the remaining footer actions**: show/hide the project
  tree (⌘B) and the Plugins tab (⌘4). All footer actions now appear in the Navigation
  group of the shortcuts editor, and the footer tooltips show their combo.

### Fixed

- **Change stripes clear after an external checkout/discard.** The open file re-syncs
  with disk on editor focus and window refocus (a checkout/discard changes the file
  without moving HEAD, so the HEAD poll alone wouldn't notice). Dirty buffers are
  skipped, so unsaved edits are never overwritten.

## [1.0.9] — 2026-06-17

### Added

- **Find all references** (Shift+F12) for Go, powered by gopls. Previously no
  reference provider was registered, so every symbol reported "No references found".
- **Last project is restored on launch**, so a multi-project setup reopens where you
  left off (then reopens that project's last file).

### Changed

- **Background polling pauses while the window is hidden** and refreshes the moment
  it regains focus — no git/IPC work piles up when the app isn't visible.

### Fixed

- **Terminal no longer clips its last row** under the status bar. The breathing room
  moved off the FitAddon-measured host (WebKitGTK reports a border-box height that
  made FitAddon over-count rows) onto a structural slot inset.
- **Copy works in hover docs, markdown preview and settings hints** under the
  macOS-style keymap on Linux — a live DOM selection is copied via the clipboard
  plugin instead of being swallowed by Monaco.
- **Git change stripes clear after committing.** The gutter baseline now follows
  HEAD, so committing (even from the integrated terminal) drops the stale markers.

## [1.0.8] — 2026-06-17

### Added

- **Go to Files shortcut** (⌘1). History moves to ⌘⇧1; the footer view tabs now
  show their shortcut in the tooltip.

### Changed

- **Settings dropdowns use a themed control** instead of the native `<select>`, so
  the popup list follows the app theme (no more OS white-on-white menu) and gains
  keyboard navigation and font previews.

### Fixed

- **Terminal spacing above the status bar.** Restored a small bottom pad so the
  prompt no longer glues to the footer when the panel height lands on a whole row
  (the 1.0.7 flush change over-corrected into a cramped foot).

## [1.0.7] — 2026-06-17

### Added

- **Window transparency.** A slider in Settings → Interface lets the desktop show
  through the whole window (Tauri transparent window + macOS private API); 100% is
  fully opaque.
- **Font weight pickers** for both the editor and the project tree, alongside the
  existing family/size controls. The Interface section is now grouped into Theme &
  colors / Fonts / Editor / Tabs & sidebar.
- **Titlebar project context.** The selected project name and its branch show on the
  left; the brand moved to the far right with the CPU/MEM meter beside it (now icons
  instead of colored dots).
- **Grouped branch/commit compare picker** in the Git tab: a searchable dropdown that
  splits refs into Local branches, Origin branches (previously not shown), and Commits.
- **Conflict resolver clarity.** The resolved result highlights each line by origin
  (ours / theirs / both); hovering a choice shows an editable preview of its result;
  the ours/theirs regions scroll and resize instead of cropping.

### Changed

- **Terminal clipboard follows the keymap style**, like the editor: ⌘C/⌘V/⌘A on
  macOS, Ctrl+Shift+C/V/A elsewhere, and physical Alt under the mac-style-on-PC
  keymap (so a bare Ctrl+C still reaches the shell as SIGINT).

### Fixed

- **Terminal sits flush with the status bar** — removed bottom padding that left a
  dead band above the footer.

## [1.0.6] — 2026-06-16

### Fixed

- **Integrated terminal now resolves user PATH tools** (docker, docker-compose,
  nvm-managed binaries, etc.). The shell is launched as a login shell (`-l`) so it
  sources the user's profile and re-runs macOS `path_helper` — a GUI-launched app
  otherwise inherits a stripped PATH. Matches how Warp/Terminal open shells. Skipped
  on Windows (`COMSPEC` rejects `-l`).
- **`.env` syntax highlighting no longer leaks across lines.** The Monarch value
  state never popped at end-of-line (the greedy content rule consumed past the `$`
  pop rule), so a following comment or key tokenized as a string. The state now pops
  at the start of the next line via `@rematch`, re-tokenizing from `root`.

## [1.0.5] — 2026-06-16

### Fixed

- **Find / search occurrences now scroll into view.** The find widget (⌘F) moved
  the selection to an off-screen match but never scrolled to it — the smooth-scroll
  reveal was being cancelled by the cursor re-render. Reveal is immediate now.
  Jumping to a search-palette result inside the already-open file also scrolls and
  focuses it (previously only worked when the file opened fresh).
- **Select all (⌘A / Ctrl+A) in the editor.** It silently did nothing — the binding
  targeted a Monaco core command via the wrong API and shadowed the native shortcut.

### Changed

- **External package files (stdlib / module cache) open editable** instead of read-only.
- **Themed command palette, quick-input, find widget, lists and menus** in the
  fftrackDark and TokyoNight themes (focus border, inputs, list focus/hover,
  picker group, keybinding labels).

## [0.5.8] — 2026-06-11

### Changed

- **History view reworked into an IDE-style explorer.** The duplicated file lists
  are gone. The project file tree is always visible; a single *history* toggle
  shows/hides the breaking-points timeline and changed-files list. Clicking a tree
  file opens it in a plain read-only editor (with active-line highlight); clicking
  a changed file opens its diff.
- **Resizable panels.** Drag the dividers to resize the explorer width and the
  project-tree / history split.

## [0.5.7] — 2026-06-11

### Added

- **Full project file tree in History.** A new *Files* section lists every tracked
  file on disk (not just the changed ones), beside the existing *Changed Files*.
  Both sections have a show/hide toggle and are shown by default. Folders and files
  now carry icons, and long single-child folder chains collapse into one row.

### Changed

- **↑/↓ change navigation now spills across files.** Stepping past the last (↓) or
  first (↑) change of a file jumps to the next/previous changed file (landing on
  its first/last change) instead of wrapping within the current file. Applies to
  both History and Git diff views.

## [0.5.4] — 2026-06-03

### Fixed

- **Homebrew now installs the `fft` CLI too.** The cask only shipped the GUI app,
  so `fft` was missing after `brew install --cask fftracking`. The release now
  publishes an `fft` formula to the tap and the cask depends on it, so the CLI
  (+ MCP server) lands on PATH. Standalone: `brew install mayckol/tap/fft`.

## [0.5.3] — 2026-06-03

### Fixed

- **Diff was clipped off the right edge when the window was narrowed.** The diff
  column had no lower width bound, so Monaco's wide content pushed the layout past
  the window. The columns can now shrink (`minmax(0,1fr)`) and the editor scrolls
  internally instead of being cut off; the diff toolbar no longer overflows either.

## [0.5.2] — 2026-06-03

### Added

- **Revert the whole folder to a breaking point from the timeline.** Right-click a
  breaking point → *Revert everything to this point* — restores the entire folder
  to that snapshot (modified files reverted, deleted recreated, files added since
  removed). A safety breaking point is captured first.
- **Confirmation dialogs now have "Don't show this again".** Applies to delete
  folder, discard file, folder revert/reset, and revert-everything; the choice is
  remembered locally and those actions then run without prompting.

### Fixed

- **Unreadable dropdowns in the Git tab.** The branch/commit `<select>` controls
  and their option lists rendered white-on-white in the webview; they now use the
  app's dark styling with a visible caret.

## [0.5.1] — 2026-06-03

### Added

- **Undo / Redo in the diff**, as toolbar buttons (↶ ↷) and bindable shortcuts
  (default ⌘Z / ⌘⇧Z, scoped to the diff so they don't hijack other text fields).
  Covers block reverts and in-diff edits.
- **Git tab: discard a file's changes** — right-click a file under *Changes* →
  *Discard changes (restore to HEAD)*, i.e. `git checkout -- <file>` (an untracked
  file is removed). Confirmation required.
- **Git tab: apply blocks when comparing revisions.** When comparing two refs the
  panes are read-only; a new *↧ Apply against working tree* button switches the
  right side to your working tree so the ⟲ gutter icon can apply blocks into it.

### Fixed

- Diff revert/redo is reliable now: the block-revert is an in-editor edit and
  Undo/Redo drive the editor's own history directly.

## [0.5.0] — 2026-06-03

### Added

- **Keyboard shortcuts, fully rebindable** (Settings → Shortcuts). Click a shortcut
  and press a new combination (Esc to cancel); bindings persist locally. Covers
  diff navigation (next/previous change, toggle split/inline, revert the current
  block), capture & revert (snapshot now, revert file to point), changed-file ops
  (copy path, copy contents, reveal in file manager, open file), and tab /
  breaking-point navigation. "Mod" is ⌘ on macOS, Ctrl elsewhere; keys are
  in-app (active while the window is focused).
- Changed files can be opened or revealed in the OS file manager.

### Fixed

- **Linux update no longer needs a manual delete.** The installer now downloads
  beside the existing binary and renames it into place, so re-running
  `curl … | sh` while the app is running succeeds instead of failing with "text
  file busy". To update: just re-run the install one-liner.

## [0.4.6] — 2026-06-03

### Changed

- **The Breaking Points view now features local history comparison.** Selecting
  a breaking point compares it directly with the **current working tree**: the left
  pane is "🔒 Before · <time>" (the file as captured at that point, read-only) and
  the right pane is "Current" (your live file, editable). The Changed Files list is
  the point↔current delta too, so every row opens a real diff.
- The ⟲ gutter icon restores that block from **Before** into **Current** (undoable
  with ⌘Z / Ctrl+Z); "Revert file/folder" restores the whole file/folder to the
  point. Branch/commit comparisons live in the **Git** tab; the History view no
  longer mixes in a "vs branch" base (git "Reset to branch" actions remain
  available per file/folder in a repo).

## [0.4.5] — 2026-06-03

### Changed

- The diff's right pane is now the **working tree in both compare modes**, so the
  ⟲ block-revert gutter icon works in the **vs branch / vs previous-point** view
  too — not only **vs now**. Clicking it restores that block to the left side
  (the branch HEAD / previous point, or the selected point) in the working tree,
  undoable with ⌘Z / Ctrl+Z. (There is no "apply into the branch/history"
  direction — git history and past breaking points are read-only; only restoring
  into the working tree is meaningful.)

## [0.4.4] — 2026-06-03

### Added

- **Ignore a file or folder straight from the changed-files tree.** Right-click a
  file → *Ignore this file*, or a folder → *Ignore this folder* (adds a
  `path/**` glob, so nested files like `.serena/nested/*` are covered too). The
  rule is appended to the ignore globs and the changed list updates immediately —
  even for files already captured in earlier breaking points.

### Changed

- The per-block revert (⟲ in the diff gutter) now applies as an in-editor edit in
  the **vs now** view, so it lands in the native undo stack — **⌘Z / Ctrl+Z** undo
  and redo a block revert. The gutter icon is shown only in the editable vs-now
  view (where reverting into the working tree is meaningful).
- Selecting a breaking point now jumps the diff to its **first change** instead of
  the top of the file.
- The gutter revert icon is high-contrast and always visible, not only on hover.

### Fixed

- The gutter revert no longer blanks the whole file. In the vs-before view it had
  written a two-snapshots diff straight to the working tree, which for an added
  file (a single whole-file block) emptied it; reverts now target the working tree
  in the vs-now view only.

## [0.4.3] — 2026-06-03

### Fixed

- **Adding a git project no longer floods the first breaking point with files.**
  In a git repo, the vs-branch comparison now ignores git-ignored files (e.g.
  `.env`, `coverage.*`, tool dirs) — fftracking still keeps their local history,
  but they're no longer shown as "added vs branch". The first breaking point is
  also treated as a clean baseline for git repos (matching non-git behavior).
- The release workflow publishes the Homebrew cask via the GitHub Contents API
  instead of a token-in-URL `git push` (which fine-grained PATs reject).

## [0.4.2] — 2026-06-03

### Fixed

- **App/CLI crashed on launch on other machines** (`Library not loaded:
  …/openssl@3/…/libssl.3.dylib`). `git2` was linking Homebrew's OpenSSL + libssh2
  via its default `https`/`ssh` features; combined with ad-hoc signing this also
  tripped a code-signing Team-ID mismatch. We only use **local** git, so those
  features are now disabled — the binaries are self-contained.
- The Homebrew cask now strips the download quarantine on install (`postflight`),
  so the app opens on a double-click instead of being blocked by Gatekeeper.

## [0.4.1] — 2026-06-03

### Fixed

- Git Commit mode: a file edited/reverted to match HEAD is deselected instead of
  leaving an empty diff that highlights no list row.
- Committing now reloads conflict state (so finishing a merge commit clears the
  conflict banner) and reports the current branch.

## [0.4.0] — 2026-06-03

### Added

- **Git staging & commit** in the Git tab: a **Commit** mode that lists staged vs
  unstaged/untracked files, with per-file and bulk **Stage / Unstage**, a
  commit-message box, and **Commit** — so you choose exactly which files go in.
  The existing ref-to-ref **Compare** mode is now a toggle beside it.
- **`fft pause` / `fft resume`** (CLI + MCP): pause a folder's tracking without
  losing history, then resume it later.
- **macOS ad-hoc signing** of release builds (`signingIdentity: "-"`), so the app
  no longer reports as "damaged" — first launch is the normal right-click → Open.

### Changed

- A monitor's **first breaking point** shows no changes (it is the baseline)
  instead of listing every file as "added".

### Fixed

- README now documents the `fft` CLI, the MCP server, and the git-aware
  comparison base.

## [0.3.0] — 2026-06-02

### Added

- **`fft` CLI.** A headless command-line binary (no GUI) that shares the desktop
  app's store: `track`, `snapshot`, `list`, `points`, `changes`, `diff`, `revert`,
  `reset`, `label`, `untrack`, `watch`. Rich `--help` and a global `--json` flag
  for scripts and AI agents. Comparison follows the same tiered base as the GUI
  (git branch in a repo, else the previous breaking point).
- **MCP server (`fft mcp`).** A stdio Model Context Protocol server exposing the
  operations as MCP tools, so Claude and other agents can drive fftracking
  directly. Register with `claude mcp add fftracking -- fft mcp`.
- The installer and release now build and ship the `fft` binary (`~/.local/bin/fft`)
  alongside the desktop app.

### Fixed

- Release artifacts are versioned correctly again: `tauri.conf.json` had not been
  bumped, so v0.2.0 assets were mislabeled `0.1.0` (and `install.sh` could not find
  them by version). v0.3.0 supersedes that release.

## [0.2.0] — 2026-06-02

### Added

- **Tiered comparison base.** A monitored folder inside a git repo now diffs its
  breaking points against the **current branch (HEAD)**; folders outside git keep
  comparing against the **previous breaking point**. The base is shown in the UI
  (`⎇ <branch>` / `previous point`) and tracks branch switches / new commits live.
- **Reset to branch.** In a git monitor, files and folders can be reset to their
  committed (HEAD) version — restores a deleted file, drops an uncommitted one,
  reverts a modified one. Available via the diff toolbar and the changed-tree
  context menu, alongside the existing "revert to this point".
- **Change badges.** The timeline and Changed Files header show per-breaking-point
  added / modified / deleted counts so the kind of change is visible at a glance.
- **Linux desktop integration.** The installer now registers a `.desktop` launcher
  and an icon under XDG dirs, so the app shows in the application menu after
  `curl … | sh` instead of being a bare binary.

### Fixed

- A same-second predecessor is no longer skipped when resolving the previous
  breaking point (row-value `(ts, id)` ordering), which had made changes show as
  all-added.
- The git HEAD comparison set now honors the monitor's own ignore rules (user
  globs, `.gitignore`) and excludes submodule working trees, removing phantom
  deletions in the change views.
- `Reset folder` with "also delete uncommitted files" no longer removes files the
  branch still tracks (e.g. ones skipped by the size cap) or anything in a submodule.
- A monitored subdirectory of a repo is scoped to its own path instead of diffing
  against the whole repository.
- After a revert/reset the view switches to "vs now" so the working-tree result is
  actually visible.

## [0.1.0] — 2026-06-02

First release. macOS + Linux.

### Added

- **Engine** (`ffcore`): recursive filesystem watcher with debounced capture,
  content-addressed blob store (blake3 dedup) backed by SQLite, and intelligent
  retention (dense today, coalesced past days, age + disk-cap pruning with blob GC).
- **Breaking points** captured on save (event) and on a per-monitor interval;
  rapid saves throttled to one point per configurable gap (default 20s, leading +
  trailing). Identical trees are skipped.
- **Monitors**: track folders manually, or have them auto-detected when a workspace
  is focused in VSCode / Zed (reads each editor's own state — no extensions, no
  special OS permissions). Remove a folder (and its history) or delete individual
  breaking points.
- **Labels** for breaking points.
- **Diff UI** (Monaco): side-by-side or inline layout, vs-before / vs-now
  comparison, change-navigation arrows, and an always-visible per-block **⟲ revert
  icon** in the gutter.
- **Revert** by block (gutter icon), file, or folder; right-click revert in the
  nested changed-files tree; in-diff editing with native undo/redo persisted to the
  working tree. Every revert is itself captured first (safety).
- **Local git** tab: diff branches / commits / working tree, per-block apply into
  the working tree, and a 3-way merge-conflict resolver (accept ours / theirs /
  both, staged on resolve).
- **Settings**: interval, minimum gap between auto-points, retention days, disk cap,
  ignore globs, respect `.gitignore` (off by default), launch on login.
- **App**: system tray (runs in background), live CPU / memory readout, app icon,
  and a build stamp in the title bar.

### Notes

- Tracks everything by default (local-history semantics) — gitignored files such as
  `.env` get history. Heavy dirs and files > 5 MB are always skipped.
- macOS builds are unsigned; first launch needs right-click → Open.

[0.1.0]: https://github.com/mayckol/fftracking/releases/tag/v0.1.0

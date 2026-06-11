# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

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

- **The Breaking Points view is now true JetBrains-style Local History.** Selecting
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

# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

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

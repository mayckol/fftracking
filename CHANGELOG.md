# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

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

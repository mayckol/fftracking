# AGENTS.md

Local file-history & breaking-point tracker (IDE-style history view, git-independent). Tauri desktop app + CLI + MCP server. macOS · Linux.

## Stack

- **Frontend**: React + TypeScript + Vite, Monaco editor. `src/`
- **Desktop shell**: Tauri (Rust). `src-tauri/`
- **Core engine**: Rust workspace crates. `crates/ffcore` (watcher, store, diff, git, search), `crates/ffcli` (`fft` CLI + MCP server).

## Layout

```
src/
  components/   Monaco editors (FileView, DiffEditor), Terminal, modals
  panels/       Views: History, Git, Settings, Sidebar, ProjectTree, Debug
  lib/          State + helpers: shortcuts, ipc, lsp, debug, uiPrefs, types
src-tauri/src/  Tauri commands, LSP/DAP/terminal bridges
crates/ffcore/  Engine: db, store, watcher, git, revert, search
crates/ffcli/   fft CLI (ops.rs) + MCP server (mcp.rs)
```

## Commands

| Task | Command |
|------|---------|
| Dev (web only) | `npm run dev` |
| Dev (desktop) | `npm run tauri dev` |
| Typecheck + build frontend | `npm run build` |
| Build desktop app | `npm run tauri build` |
| Rust check | `cargo check` |
| Rust test | `cargo test` |

`npm run build` runs `tsc` then `vite build` — use it to verify TS changes.

## Conventions

- Frontend↔Rust calls go through `src/lib/ipc.ts` → Tauri `commands.rs`.
- Keyboard shortcuts: declare in `src/lib/shortcuts.ts` (`ACTIONS`), bind editor combos in the Monaco `onMount`.
- Editor theme/colors: `src/components/monacoTheme.ts`.
- Functions: max 3 params; more → use a struct/object param.
- Comments: explain *why*, not *what*. No redundant/obvious comments.
- Never edit files under `docs/` manually.

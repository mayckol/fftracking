<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
    <img src="assets/logo-light.png" alt="fftracking" width="340" />
  </picture>
</p>

<p align="center">
  Local file-history &amp; breaking-point tracker — JetBrains <em>Local History</em> style, independent of git.<br/>
  <b>macOS · Linux</b>
</p>

---

fftracking watches your folders recursively and captures **breaking points**
(snapshots) as you work — on every save and on a timer. Browse the timeline,
diff any point side-by-side, and revert by block, file, or folder. It also has a
local **git compare** tab with per-block revert and a merge-conflict resolver.

## Features

- **Automatic breaking points** — captured on file save (debounced) and on an
  interval; rapid saves coalesce into one point per configurable gap (default 20s).
- **Content-addressed store** — blake3-deduplicated blobs; one changed file in a
  10k-file tree stores a single new blob.
- **JetBrains-style diff** — Monaco side-by-side or inline, change-navigation
  arrows, and an always-visible **⟲ revert icon** on every changed block.
- **Revert anything** — per block (gutter ⟲), per file, or per folder; right-click
  the changed-files tree to revert; in-diff editing with Cmd+Z / Cmd+Shift+Z.
- **Labels** — name any breaking point (e.g. "before refactor").
- **Editor auto-detect** — opens a folder in VSCode or Zed and fftracking starts
  tracking the focused workspace automatically (no extensions).
- **Local git** — diff branches / commits / working tree, per-block apply, and a
  3-way merge-conflict resolver (accept ours / theirs / both).
- **Smart retention** — today stays dense, past days coalesce, anything past the
  window is pruned, and the store is capped (default 1 GB).
- **Lightweight** — runs in the tray, shows live CPU / memory in the title bar.

## Install

### Quick install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/mayckol/fftracking/main/scripts/install.sh | sh
```

Installs the latest release — `fftracking.app` to `/Applications` on macOS
(Apple Silicon), or the AppImage to `~/.local/bin/fftracking` on Linux (x86_64).
Pin a version with `FFTRACKING_VERSION=v0.1.0`.

### Homebrew (macOS)

```bash
brew install --cask mayckol/tap/fftracking
```

### From a release

Download the artifact for your OS from the
[Releases](https://github.com/mayckol/fftracking/releases) page:

- **macOS** — `fftracking_<version>_aarch64.dmg` (Apple Silicon). Open the DMG and
  drag **fftracking** to Applications. First launch: right-click → **Open** (the
  build is unsigned).
- **Linux** — `.AppImage` (`chmod +x` then run) or `.deb`
  (`sudo dpkg -i fftracking_<version>_amd64.deb`).

### From source

**Requirements**

- [Rust](https://rustup.rs) (stable) and Cargo
- [Node.js](https://nodejs.org) 18+ and npm
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: WebKitGTK + build deps, e.g. on Debian/Ubuntu:

  ```bash
  sudo apt update && sudo apt install -y \
    libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

**Build & install**

```bash
git clone git@github.com:mayckol/fftracking.git
cd fftracking
npm install
npm run tauri build
```

Bundles land in `target/release/bundle/`:
- macOS: `bundle/macos/fftracking.app` (copy to `/Applications`) and `bundle/dmg/`
- Linux: `bundle/appimage/` and `bundle/deb/`

## Develop

```bash
npm install
npm run tauri dev     # hot-reload app (Vite + Rust)
cargo test -p ffcore  # engine tests
```

## Usage

1. **+ Folder** (or just open a project in VSCode / Zed — it's picked up automatically).
2. Edit files; breaking points appear in the timeline. **⦿ Snapshot now** forces one.
3. Click a point → a file → see the diff. Toggle **vs before / vs now** and
   **split / inline**. Use **↑ ↓** to jump between changes.
4. Revert with the gutter **⟲**, the **Revert file / folder** buttons, or
   right-click in the changed-files tree. Label a point with **🏷**, delete with **×**.
5. **Git** tab — pick a repo and two refs (or the working tree) to compare, apply
   blocks, and resolve merge conflicts.
6. **Settings** — interval, min gap, retention, disk cap, ignore globs, respect
   `.gitignore` (off by default — like local history), launch on login.

## Data

State lives in the OS app-data dir (`db.sqlite` + `objects/<blake3>` blobs):

- macOS: `~/Library/Application Support/com.fftracking.app/`
- Linux: `~/.local/share/com.fftracking.app/`

By default fftracking tracks **everything** (so files like `.env` get history) and
skips heavy dirs (`.git`, `node_modules`, `target`, `dist`, …) plus files > 5 MB.

## Architecture

- **`crates/ffcore`** — Rust engine: watcher (`notify`), content-addressed store
  (blake3 + SQLite), retention/prune, local git (`git2`), editor detection. Fully
  unit-tested, no UI deps.
- **`src-tauri`** — Tauri v2 shell: IPC commands, tray, autostart, detect daemon.
- **`src`** — React + Monaco diff UI.

## License

MIT

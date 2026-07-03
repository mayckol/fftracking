#!/bin/sh
# fftracking installer — curl | sh friendly.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mayckol/fftracking/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | FFTRACKING_VERSION=v0.1.0 sh
#   curl -fsSL .../install.sh | sh -s -- --uninstall   # remove app + CLIs (keeps history)
#
# Env:
#   FFTRACKING_VERSION  tag to install (default: latest release)
#   FFTRACKING_PREFIX   Linux install prefix; AppImage goes to $PREFIX/bin (default: $HOME/.local)
#   FFTRACKING_REPO     override repo slug (default: mayckol/fftracking)
#   FFTRACKING_NO_MCR   set to 1 to skip installing MCR (the merge/diff companion app)
#
# Flags:
#   --uninstall, --purge   remove the app, the `fft` and `fftrack` CLIs, and the
#                          Linux desktop entry/icon. Tracked history (the app
#                          data dir) is left untouched.
#
# macOS: installs fftracking.app to /Applications (Apple Silicon).
# Linux: installs the AppImage to $PREFIX/bin/fftracking (x86_64) and registers a
#        desktop launcher + icon under $PREFIX/share so it appears in the app menu.
# Both: also installs the headless `fft` CLI (+ MCP server) to ~/.local/bin/fft,
#       and MCR (github.com/mayckol/mcr) — the external merge/diff editor the app
#       launches for git conflicts and compare — when it isn't installed yet.

set -eu

REPO="${FFTRACKING_REPO:-mayckol/fftracking}"
PREFIX="${FFTRACKING_PREFIX:-$HOME/.local}"
VERSION="${FFTRACKING_VERSION:-}"

ACTION=install
for a in "$@"; do
  case "$a" in
    --uninstall|--purge|--remove) ACTION=uninstall ;;
    -h|--help) printf 'fftracking installer: pass --uninstall to remove.\n'; exit 0 ;;
    *) printf 'warning: ignoring unknown flag: %s\n' "$a" >&2 ;;
  esac
done

log()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then DL='curl -fsSL'; else
  command -v wget >/dev/null 2>&1 || fail "need curl or wget"; DL='wget -qO-'; fi

os_raw="$(uname -s)"; arch_raw="$(uname -m)"

# Remove the app + both CLIs (and Linux desktop integration), leaving the
# tracked-history data dir in place. Missing items are skipped quietly.
uninstall() {
  log "uninstalling fftracking ($os_raw)"
  rm -f "$HOME/.local/bin/fft" "$HOME/.local/bin/fftrack" "/usr/local/bin/fftrack" 2>/dev/null || true
  case "$os_raw" in
    Darwin)
      rm -rf "/Applications/fftracking.app" 2>/dev/null || true
      ;;
    Linux)
      rm -f "$PREFIX/bin/fftracking" "$PREFIX/bin/fftracking.AppImage" 2>/dev/null || true
      rm -f "$PREFIX/share/applications/fftracking.desktop" 2>/dev/null || true
      rm -f "$PREFIX/share/icons/hicolor/256x256/apps/fftracking.png" 2>/dev/null || true
      command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$PREFIX/share/applications" >/dev/null 2>&1 || true
      command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f "$PREFIX/share/icons/hicolor" >/dev/null 2>&1 || true
      ;;
  esac
  log "removed app + CLIs. Tracked history was kept (delete the app data dir to purge it)."
  exit 0
}

[ "$ACTION" = uninstall ] && uninstall

if [ -z "$VERSION" ]; then
  log "resolving latest release for $REPO"
  VERSION="$($DL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$VERSION" ] || fail "could not resolve latest version"
fi
case "$VERSION" in v*) VER_NUM="${VERSION#v}" ;; *) VER_NUM="$VERSION"; VERSION="v$VERSION" ;; esac
BASE="https://github.com/$REPO/releases/download/$VERSION"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t fftracking)"
trap 'rm -rf "$TMP"' EXIT INT HUP TERM

# Look up the real bundle filename for a tag instead of constructing it. Tauri
# stamps bundle names from the app's config version (tauri.conf.json), which can
# lag the git tag — so a tag-built filename 404s whenever the two drift. Match by
# suffix regex (e.g. '_amd64\.AppImage') and let the caller fall back if empty.
resolve_asset() {
  $DL "https://api.github.com/repos/$REPO/releases/tags/$VERSION" 2>/dev/null \
    | sed -n 's/.*"name":[[:space:]]*"\(fftracking[^"]*'"$1"'\)".*/\1/p' | head -n1
}

# Installs the headless `fft` CLI (+ MCP server) into ~/.local/bin. Gracefully
# skips when a release predates the CLI and has no such asset.
install_cli() {
  asset="$1"
  cli_dir="$HOME/.local/bin"; mkdir -p "$cli_dir"
  log "downloading $asset"
  # Download beside the target and rename into place: an atomic replace that
  # succeeds even when the old `fft` is running (a direct `> "$cli_dir/fft"`
  # truncates a busy binary and fails with "text file busy" on Linux).
  if $DL "$BASE/$asset" > "$cli_dir/fft.new" 2>/dev/null && [ -s "$cli_dir/fft.new" ]; then
    chmod +x "$cli_dir/fft.new"
    [ "$os_raw" = "Darwin" ] && xattr -dr com.apple.quarantine "$cli_dir/fft.new" 2>/dev/null || true
    mv -f "$cli_dir/fft.new" "$cli_dir/fft"
    log "installed CLI: $cli_dir/fft"
    case ":$PATH:" in *":$cli_dir:"*) : ;; *) log "add $cli_dir to your PATH to use 'fft'" ;; esac
    log "AI agents: register the MCP server with  claude mcp add fftracking -- fft mcp"
  else
    rm -f "$cli_dir/fft.new" 2>/dev/null || true
    log "no fft CLI asset for this release ($asset) — skipping"
  fi
}

case "$os_raw" in
  Darwin)
    [ "$arch_raw" = "arm64" ] || fail "macOS build is Apple Silicon (arm64) only; got $arch_raw"
    ASSET="$(resolve_asset '_aarch64\.dmg')"; [ -n "$ASSET" ] || ASSET="fftracking_${VER_NUM}_aarch64.dmg"
    log "downloading $ASSET"
    $DL "$BASE/$ASSET" > "$TMP/app.dmg" || fail "download failed: $BASE/$ASSET"
    log "mounting"
    MNT="$(hdiutil attach -nobrowse -quiet "$TMP/app.dmg" | tail -1 | awk '{ $1=""; $2=""; sub(/^  */,""); print }')"
    [ -d "$MNT/fftracking.app" ] || { hdiutil detach -quiet "$MNT" 2>/dev/null || true; fail "fftracking.app not found in dmg"; }
    rm -rf /Applications/fftracking.app 2>/dev/null || true
    cp -R "$MNT/fftracking.app" /Applications/ || { hdiutil detach -quiet "$MNT"; fail "copy to /Applications failed (try sudo)"; }
    hdiutil detach -quiet "$MNT" || true
    xattr -dr com.apple.quarantine /Applications/fftracking.app 2>/dev/null || true
    log "installed: /Applications/fftracking.app"
    log "first launch: right-click → Open (unsigned build)"
    install_cli "fft-aarch64-apple-darwin"
    ;;
  Linux)
    case "$arch_raw" in x86_64|amd64) : ;; *) fail "Linux build is x86_64 only; got $arch_raw" ;; esac
    ASSET="$(resolve_asset '_amd64\.AppImage')"; [ -n "$ASSET" ] || ASSET="fftracking_${VER_NUM}_amd64.AppImage"
    BIN_DIR="$PREFIX/bin"; mkdir -p "$BIN_DIR"
    # The AppImage runtime keeps the terminal attached until the app quits, so
    # `fftracking <path>` would block the shell. Install the AppImage under its
    # own name and front it with a `fftracking` wrapper that detaches (nohup &),
    # mirroring the in-app `fftrack` launcher.
    APP="$BIN_DIR/fftracking.AppImage"
    BIN="$BIN_DIR/fftracking"
    log "downloading $ASSET"
    # Download to a sibling temp file and atomically rename over the old one, so
    # updating works while the app is running (writing a busy executable in place
    # fails with "text file busy" and would force a manual delete first).
    $DL "$BASE/$ASSET" > "$APP.new" || { rm -f "$APP.new"; fail "download failed: $BASE/$ASSET"; }
    chmod +x "$APP.new"
    mv -f "$APP.new" "$APP"

    # Wrapper: resolve a relative path to absolute before detaching (the AppImage
    # chdir's into its mount, so a relative arg would resolve against /tmp/.mount_*
    # instead of the shell's cwd). No arg → open the app with no project.
    cat > "$BIN.new" <<WRAP
#!/bin/sh
app="$APP"
if [ "\$#" -eq 0 ]; then
  nohup "\$app" >/dev/null 2>&1 &
else
  d="\$1"
  case "\$d" in
    /*) p="\$d" ;;
    *) p="\$(cd "\$d" 2>/dev/null && pwd)" || p="\$(pwd)/\$d" ;;
  esac
  nohup "\$app" "\$p" >/dev/null 2>&1 &
fi
WRAP
    chmod +x "$BIN.new"
    mv -f "$BIN.new" "$BIN"
    log "installed: $APP (launcher: $BIN)"

    # Desktop integration: a .desktop launcher + icon under XDG dirs so the app
    # shows in the application menu with an icon (the binary alone does not).
    APPS_DIR="$PREFIX/share/applications"
    ICON_DIR="$PREFIX/share/icons/hicolor/256x256/apps"
    mkdir -p "$APPS_DIR" "$ICON_DIR"

    # Pull the icon out of the AppImage (extraction needs no FUSE); fall back to
    # the repo's bundled icon if the runtime can't extract.
    ( cd "$TMP" && "$APP" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 ) || true
    ICON_SRC="$(find "$TMP/squashfs-root" -name 'fftracking.png' -printf '%s %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
    if [ -n "${ICON_SRC:-}" ] && [ -f "$ICON_SRC" ]; then
      cp "$ICON_SRC" "$ICON_DIR/fftracking.png"
    else
      $DL "https://raw.githubusercontent.com/$REPO/main/src-tauri/icons/128x128@2x.png" > "$ICON_DIR/fftracking.png" 2>/dev/null || \
        log "could not install an icon (menu entry will use a generic one)"
    fi
    rm -rf "$TMP/squashfs-root" 2>/dev/null || true

    cat > "$APPS_DIR/fftracking.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=fftracking
Comment=Local file-history & breaking-point tracker
Exec="$APP"
Icon=fftracking
Terminal=false
Categories=Development;Utility;
StartupWMClass=fftracking
EOF
    chmod 644 "$APPS_DIR/fftracking.desktop"

    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
    command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f "$PREFIX/share/icons/hicolor" >/dev/null 2>&1 || true

    log "menu entry: $APPS_DIR/fftracking.desktop"
    case ":$PATH:" in *":$BIN_DIR:"*) : ;; *) log "add $BIN_DIR to your PATH" ;; esac
    install_cli "fft-x86_64-unknown-linux-gnu"
    ;;
  *) fail "unsupported OS: $os_raw" ;;
esac

# MCR is the external merge/diff editor fftracking spawns for git conflicts and
# compare. Its own installer covers the same OS matrix (macOS arm64 dmg, Linux
# x86_64 AppImage) and registers it as a git mergetool. Skipped when already
# installed (update MCR independently) or when opted out; never fatal — the app
# runs without it and points at the installer from a toast.
install_mcr() {
  [ "${FFTRACKING_NO_MCR:-0}" = "1" ] && { log "skipping MCR (FFTRACKING_NO_MCR=1)"; return 0; }
  if command -v mcr >/dev/null 2>&1 || [ -x "$HOME/.local/bin/mcr" ] || [ -x "/Applications/MCR.app/Contents/MacOS/mcr-app" ]; then
    log "MCR already installed — skipping (re-run its installer to update)"
    return 0
  fi
  log "installing MCR (merge/diff editor)"
  if $DL "https://raw.githubusercontent.com/mayckol/mcr/main/scripts/install.sh" | sh; then
    log "MCR installed"
  else
    log "MCR install failed — fftracking works without it; install later with:"
    log "  curl -fsSL https://raw.githubusercontent.com/mayckol/mcr/main/scripts/install.sh | sh"
  fi
}
install_mcr

log "done"

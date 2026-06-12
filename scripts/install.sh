#!/bin/sh
# fftracking installer — curl | sh friendly.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mayckol/fftracking/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | FFTRACKING_VERSION=v0.1.0 sh
#
# Env:
#   FFTRACKING_VERSION  tag to install (default: latest release)
#   FFTRACKING_PREFIX   Linux install prefix; AppImage goes to $PREFIX/bin (default: $HOME/.local)
#   FFTRACKING_REPO     override repo slug (default: mayckol/fftracking)
#
# macOS: installs fftracking.app to /Applications (Apple Silicon).
# Linux: installs the AppImage to $PREFIX/bin/fftracking (x86_64) and registers a
#        desktop launcher + icon under $PREFIX/share so it appears in the app menu.
# Both: also installs the headless `fft` CLI (+ MCP server) to ~/.local/bin/fft.

set -eu

REPO="${FFTRACKING_REPO:-mayckol/fftracking}"
PREFIX="${FFTRACKING_PREFIX:-$HOME/.local}"
VERSION="${FFTRACKING_VERSION:-}"

log()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then DL='curl -fsSL'; else
  command -v wget >/dev/null 2>&1 || fail "need curl or wget"; DL='wget -qO-'; fi

os_raw="$(uname -s)"; arch_raw="$(uname -m)"

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
    BIN="$BIN_DIR/fftracking"
    log "downloading $ASSET"
    # Download to a sibling temp file and atomically rename over the old one, so
    # updating works while the app is running (writing a busy executable in place
    # fails with "text file busy" and would force a manual delete first).
    $DL "$BASE/$ASSET" > "$BIN.new" || { rm -f "$BIN.new"; fail "download failed: $BASE/$ASSET"; }
    chmod +x "$BIN.new"
    mv -f "$BIN.new" "$BIN"
    log "installed: $BIN"

    # Desktop integration: a .desktop launcher + icon under XDG dirs so the app
    # shows in the application menu with an icon (the binary alone does not).
    APPS_DIR="$PREFIX/share/applications"
    ICON_DIR="$PREFIX/share/icons/hicolor/256x256/apps"
    mkdir -p "$APPS_DIR" "$ICON_DIR"

    # Pull the icon out of the AppImage (extraction needs no FUSE); fall back to
    # the repo's bundled icon if the runtime can't extract.
    ( cd "$TMP" && "$BIN" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 ) || true
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
Exec="$BIN"
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

log "done"

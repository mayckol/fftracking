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
# Linux: installs the AppImage to $PREFIX/bin/fftracking (x86_64).

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

case "$os_raw" in
  Darwin)
    [ "$arch_raw" = "arm64" ] || fail "macOS build is Apple Silicon (arm64) only; got $arch_raw"
    ASSET="fftracking_${VER_NUM}_aarch64.dmg"
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
    ;;
  Linux)
    case "$arch_raw" in x86_64|amd64) : ;; *) fail "Linux build is x86_64 only; got $arch_raw" ;; esac
    ASSET="fftracking_${VER_NUM}_amd64.AppImage"
    BIN_DIR="$PREFIX/bin"; mkdir -p "$BIN_DIR"
    log "downloading $ASSET"
    $DL "$BASE/$ASSET" > "$BIN_DIR/fftracking" || fail "download failed: $BASE/$ASSET"
    chmod +x "$BIN_DIR/fftracking"
    log "installed: $BIN_DIR/fftracking"
    case ":$PATH:" in *":$BIN_DIR:"*) : ;; *) log "add $BIN_DIR to your PATH" ;; esac
    ;;
  *) fail "unsupported OS: $os_raw" ;;
esac

log "done"

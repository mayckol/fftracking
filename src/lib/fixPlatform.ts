// WebKitGTK (the Linux Tauri webview) reports a "Macintosh" userAgent. Monaco
// reads navigator.userAgent once, at import time, to decide its operating system
// (vs/base/common/platform: isMacintosh = userAgent.indexOf('Macintosh') >= 0).
// It then concludes it is running on macOS and binds every CtrlCmd keybinding —
// save (Ctrl+S), find (Ctrl+F), indent, select-all, and all of ours — to the
// Meta/Super key instead of Ctrl, so they silently do nothing on Linux.
//
// Strip the Mac tokens from the userAgent on a confirmed non-macOS host BEFORE
// Monaco's modules evaluate. This file MUST be the first import in the entry
// point so it runs ahead of `import "monaco-editor"`.

function tauriOS(): string | null {
  try {
    return (window as unknown as { __TAURI_OS_PLUGIN_INTERNALS__?: { platform?: string } })
      .__TAURI_OS_PLUGIN_INTERNALS__?.platform ?? null;
  } catch {
    return null;
  }
}

try {
  const ua = navigator.userAgent || "";
  const os = tauriOS();
  // Only act inside a Tauri webview on a host the OS plugin says is NOT macOS;
  // never touch a real Mac or a plain browser (where os is null).
  if (os && os !== "macos" && /Macintosh|Mac OS X/i.test(ua)) {
    // Monaco matches "Linux"/"Windows" case-sensitively, so use proper tokens.
    const token = os === "windows" ? "Windows NT 10.0; Win64; x64" : `X11; ${os === "linux" ? "Linux x86_64" : os}`;
    const patched = ua.replace(/\(Macintosh;[^)]*\)/i, `(${token})`).replace(/Macintosh|Mac OS X/gi, "");
    Object.defineProperty(navigator, "userAgent", { value: patched, configurable: true });
  }
} catch {
  // userAgent not redefinable on this engine: the WinCtrl editor bindings in
  // resolveScheme (physical Ctrl, layout-independent of Monaco's OS guess) keep
  // our own shortcuts working even if Monaco still misreads the platform.
}

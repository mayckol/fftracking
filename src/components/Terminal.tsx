import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/ipc";
import { setTerminalSink } from "../lib/runner";
import { getTheme } from "../lib/themes";
import { terminalClipboardIntent } from "../lib/shortcuts";
import { getPrefs, subscribePrefs } from "../lib/uiPrefs";

interface Props {
  cwd: string | null;
  active: boolean;
  onExit: () => void;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// xterm colours from the active app theme so the terminal matches the editor
// surface (background === editor.background) instead of a fixed palette.
function xtermTheme() {
  const v = getTheme(getPrefs().theme).cssVars;
  return {
    background: v["--bg-0"],
    foreground: v["--tx-0"],
    cursor: v["--ac"],
    selectionBackground: v["--bg-4"],
  };
}

export default function Terminal({ cwd, active, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const idRef = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const term = new XTerm({
      // JetBrains Mono lacks powerline/Nerd-Font glyphs; the browser falls back
      // per-glyph to whichever Nerd Font the user has installed (the same one
      // their prompt already relies on in other terminals).
      fontFamily:
        '"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "Hack Nerd Font", "FiraCode Nerd Font", "Symbols Nerd Font", "Symbols Nerd Font Mono", "Apple Color Emoji", monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Underline http(s) links and hand clicks to the OS browser. The webview
    // would otherwise navigate itself, so route through the Tauri command.
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void api.openUrl(uri);
      }),
    );

    // Copy/paste/select-all follow the chosen keymap style (like the editor):
    // ⌘ on a Mac, Ctrl+Shift elsewhere, and physical Alt under mac-style-on-PC.
    // WebKitGTK blocks the browser clipboard, so route through the Tauri plugin.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const intent = terminalClipboardIntent(e);
      if (!intent) return true;
      e.preventDefault();
      if (intent === "selectAll") {
        term.selectAll();
        return false;
      }
      if (intent === "copy") {
        const sel = term.getSelection();
        if (sel) void writeText(sel);
        return false;
      }
      void (async () => {
        const text = await readText().catch(() => "");
        if (text && idRef.current != null) api.terminalWrite(idRef.current, text);
      })();
      return false;
    });

    term.open(host.current!);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let unlistenOut: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    (async () => {
      const id = await api.terminalOpen(cwd, term.cols || 80, term.rows || 24);
      if (disposed) {
        api.terminalClose(id);
        return;
      }
      idRef.current = id;
      unlistenOut = await listen<{ id: number; data: string }>("terminal://output", (e) => {
        if (e.payload.id === id) term.write(b64ToBytes(e.payload.data));
      });
      unlistenExit = await listen<number>("terminal://exit", (e) => {
        if (e.payload === id) onExitRef.current();
      });
    })();

    const dataSub = term.onData((d) => {
      if (idRef.current != null) api.terminalWrite(idRef.current, d);
    });

    const ro = new ResizeObserver(() => {
      const el = host.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (idRef.current != null) api.terminalResize(idRef.current, term.cols, term.rows);
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      unlistenOut?.();
      unlistenExit?.();
      if (idRef.current != null) api.terminalClose(idRef.current);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow live theme switches (re-applies xterm colours from the new palette).
  useEffect(() => subscribePrefs(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme();
  }), []);

  // The visible terminal accepts injected commands (test runner). Returns
  // false until the PTY is open so the runner keeps the command queued.
  useEffect(() => {
    if (!active) return;
    setTerminalSink((cmd) => {
      if (idRef.current == null) return false;
      api.terminalWrite(idRef.current, cmd + "\n");
      return true;
    });
    return () => setTerminalSink(null);
  }, [active]);

  // Becoming visible: re-fit (it was display:none, so size was 0) and focus.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      if (idRef.current != null && termRef.current)
        api.terminalResize(idRef.current, termRef.current.cols, termRef.current.rows);
      termRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [active]);

  return <div className="term-host" ref={host} />;
}

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/ipc";

interface Props {
  cwd: string | null;
  active: boolean;
  onExit: () => void;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export default function Terminal({ cwd, active, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const idRef = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0a0c10",
        foreground: "#e6edf3",
        cursor: "#7c8cff",
        selectionBackground: "#33455a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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

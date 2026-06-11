// Bridge from "run this test" gutter actions to the integrated terminal.
// The opener (App) shows the terminal panel; the sink (the active Terminal)
// types the command into its PTY. Commands queue until both exist — the PTY
// opens asynchronously right after the panel mounts.

let opener: (() => void) | null = null;
let sink: ((cmd: string) => boolean) | null = null;
let pending: string[] = [];
let retry = 0;

export function setTerminalOpener(fn: (() => void) | null) {
  opener = fn;
}

/** The active terminal registers here; must return false while its PTY isn't
 *  ready yet so the command stays queued. */
export function setTerminalSink(fn: ((cmd: string) => boolean) | null) {
  sink = fn;
  if (fn) flush();
}

function flush() {
  window.clearTimeout(retry);
  if (!sink) return;
  pending = pending.filter((cmd) => !sink!(cmd));
  if (pending.length) retry = window.setTimeout(flush, 200);
}

export function runInTerminal(cmd: string) {
  opener?.();
  pending.push(cmd);
  flush();
}

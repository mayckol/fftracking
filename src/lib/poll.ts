/** Run `fn` every `ms`, but only while the window/tab is visible — no work piles
 *  up in the background. Re-fires once the moment the tab becomes visible again so
 *  the view catches up immediately instead of waiting out the interval. Callers
 *  keep their own initial (mount) call; this owns just the recurring cadence.
 *  Returns a cleanup that stops the timer and drops the listener. */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  const run = () => {
    if (document.visibilityState === "visible") fn();
  };
  const timer = window.setInterval(run, ms);
  document.addEventListener("visibilitychange", run);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", run);
  };
}

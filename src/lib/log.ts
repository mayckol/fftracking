// Mirror the webview's console output and uncaught errors to the Tauri log
// plugin, which writes them to stdout (the `tauri dev` terminal) and to a file
// you can `tail -f`. The path is printed at startup: <app_log_dir>/ff.log — on
// Linux ~/.local/share/com.fftracking.app/logs/ff.log. Outside Tauri (a plain
// browser preview) the plugin calls reject and are swallowed, so the console
// still behaves normally.
import { trace, debug, info, warn, error } from "@tauri-apps/plugin-log";

type Level = "log" | "info" | "warn" | "error" | "debug" | "trace";
type Forward = (msg: string) => Promise<void>;

// A CSS string passed as a styling arg to console.log("%c…", "color:…", …).
const STYLE_ARG = /(^|;)\s*(color|font|background|padding|margin)\s*:/;

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .replace(/%c/g, "")
    .trim();
}

function patch(level: Level, forward: Forward) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const cleaned = args.filter((a, i) => !(i > 0 && typeof a === "string" && STYLE_ARG.test(a)));
    const msg = stringify(cleaned);
    if (msg) void forward(msg).catch(() => {});
  };
}

let installed = false;
/** Tees console.* and window errors to the on-disk / stdout app log. Call once,
 *  as early as possible, so startup logs are captured too. */
export function installLogForwarding() {
  if (installed) return;
  installed = true;
  patch("log", info);
  patch("info", info);
  patch("debug", debug);
  patch("trace", trace);
  patch("warn", warn);
  patch("error", error);
  window.addEventListener("error", (e) => {
    void error(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    void error(`unhandledrejection: ${String(e.reason)}`).catch(() => {});
  });
}

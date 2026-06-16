// In-app keyboard shortcuts: a small action registry + one global key handler.
// Bindings are user-editable (Settings → Shortcuts) and persisted to
// localStorage. "Mod" is ⌘ on macOS and Ctrl elsewhere.

import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { monacoSeesMac } from "./fixPlatform";
import { type KeymapStyle, getPrefs, subscribePrefs } from "./uiPrefs";

export type ActionGroup = "Editor" | "Diff" | "Capture & revert" | "Changed files" | "Navigation" | "Search" | "Debug";

/** Pseudo-combo for two bare Shift presses in quick succession (JetBrains
 *  "Search Everywhere"). Handled by a dedicated detector, not combo matching. */
export const DOUBLE_SHIFT = "DoubleShift";

/** True when the *physical machine* is a Mac, independent of the chosen keymap
 *  style. Style decides the scheme; this decides where the ⌘ key physically is.
 *  WebKitGTK on Linux masquerades as "MacIntel" in navigator.platform/userAgent,
 *  so we ask the OS plugin (the real OS from Rust) and only fall back to the
 *  unreliable navigator sniff outside a Tauri webview (tests). */
function detectMac(): boolean {
  try {
    return platform() === "macos";
  } catch {
    return /mac/i.test(navigator.platform || navigator.userAgent || "");
  }
}
export const IS_MAC = detectMac();

/** True when the host is Linux. WebKitGTK (the Linux Tauri webview) blocks the
 *  browser clipboard APIs Monaco's built-in copy/cut/paste rely on, so the editor
 *  routes those through the Tauri clipboard plugin there. */
function detectLinux(): boolean {
  try {
    return platform() === "linux";
  } catch {
    return /linux/i.test(navigator.platform || navigator.userAgent || "");
  }
}
export const IS_LINUX = detectLinux();

// Opt-in diagnostics for shortcuts that silently do nothing (the usual Linux/
// WebKitGTK failure mode). Enable from the devtools console with
//   localStorage.setItem("ff.debugShortcuts", "1")
// then reload; disable by removing the key. Logs platform detection at install
// and, for every keydown, the resolved combo plus the reason it did or didn't
// fire. window.ffShortcutsDebug() prints the current detection snapshot on demand.
let DEBUG = (() => {
  try {
    return localStorage.getItem("ff.debugShortcuts") === "1";
  } catch {
    return false;
  }
})();
function dbg(...args: unknown[]) {
  if (DEBUG) console.log("%c[shortcuts]", "color:#7c3aed;font-weight:bold", ...args);
}
/** True when shortcut diagnostics are on; lets other modules (Monaco bindings in
 *  FileView) log under the same opt-in flag. */
export function shortcutsDebugEnabled(): boolean {
  return DEBUG;
}
function detectionSnapshot() {
  let osPlugin: string;
  try {
    osPlugin = platform();
  } catch (e) {
    osPlugin = `unavailable (${String(e)})`;
  }
  return {
    "platform() (Tauri OS)": osPlugin,
    IS_MAC,
    monacoSeesMac,
    "navigator.platform": navigator.platform,
    "navigator.userAgent": navigator.userAgent,
    keymapStyle: getPrefs().keymapStyle,
    scheme: { mod: scheme.mod, alt: scheme.alt, monacoMod: scheme.monacoMod, monacoAlt: scheme.monacoAlt },
  };
}

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  default: string;
  /** When "diff", the binding only fires while the diff editor has focus, so it
   *  doesn't steal keys (e.g. ⌘Z) from other text fields. */
  scope?: "diff";
}

export const ACTIONS: ActionDef[] = [
  // Editor actions are bound inside Monaco (the editor reads these combos); they
  // have no global handler, so the key passes through to the focused editor.
  { id: "editor.format", label: "Format document", group: "Editor", default: "Mod+Shift+L" },
  { id: "editor.gotoDef", label: "Go to definition", group: "Editor", default: "F12" },
  { id: "editor.save", label: "Save file", group: "Editor", default: "Mod+S" },
  { id: "editor.selectAll", label: "Select all", group: "Editor", default: "Mod+A" },
  { id: "editor.gotoLineEnd", label: "Go to end of line", group: "Editor", default: "Ctrl+E" },
  // Delete-line is the physical Ctrl key on every platform so Linux window
  // managers don't swallow it the way they do Alt+letter mnemonics. Duplicate
  // is ⌥D on a Mac (plus ⌘D, bound in FileView); off Mac it uses the *literal*
  // Ctrl key (not Mod) so it lands on physical Ctrl in both the pc and
  // mac-on-PC schemes — Mod maps to the swallowed Alt key under mac style.
  { id: "editor.duplicateLine", label: "Duplicate line", group: "Editor", default: IS_MAC ? "Alt+D" : "Ctrl+Shift+D" },
  { id: "editor.deleteWord", label: "Delete word (end → start)", group: "Editor", default: "Mod+W" },
  { id: "editor.deleteLine", label: "Delete line", group: "Editor", default: "Ctrl+D" },
  { id: "editor.gotoLine", label: "Go to line…", group: "Editor", default: "Mod+G" },
  { id: "editor.replace", label: "Replace in file", group: "Editor", default: "Mod+R" },
  { id: "editor.expandSelection", label: "Expand selection", group: "Editor", default: "Mod+Shift+]" },
  { id: "editor.shrinkSelection", label: "Shrink selection", group: "Editor", default: "Mod+Shift+[" },
  { id: "editor.jumpBracket", label: "Go to matching bracket", group: "Editor", default: "Mod+[" },
  { id: "editor.gotoFileStart", label: "Go to first line", group: "Editor", default: "Mod+ArrowUp" },
  { id: "editor.gotoFileEnd", label: "Go to last line", group: "Editor", default: "Mod+ArrowDown" },
  { id: "editor.commentLine", label: "Toggle comment (line / selection)", group: "Editor", default: "Mod+/" },
  { id: "editor.implementations", label: "Go to implementations / specifications", group: "Editor", default: "Mod+U" },
  { id: "editor.implementIface", label: "Implement interface (generate stubs)", group: "Editor", default: "Ctrl+I" },
  // Run-test sits on the physical Ctrl key (T for test) so Linux WMs don't
  // swallow it; moved off Shift+R so it no longer shares a physical chord with
  // search.replace (Mod+Shift+R) under the PC keymap, where Mod is physical Ctrl.
  { id: "test.run", label: "Run test at cursor", group: "Editor", default: "Ctrl+Shift+T" },
  { id: "editor.fold", label: "Collapse block (press twice: all)", group: "Editor", default: "Mod+Shift+-" },
  { id: "editor.unfold", label: "Expand block (press twice: all)", group: "Editor", default: "Mod+Shift+=" },
  { id: "editor.zoomIn", label: "Zoom in", group: "Editor", default: "Mod+=" },
  { id: "editor.zoomOut", label: "Zoom out", group: "Editor", default: "Mod+-" },
  { id: "editor.zoomReset", label: "Reset zoom (100%)", group: "Editor", default: "Mod+0" },
  { id: "diff.next", label: "Next change", group: "Diff", default: "Alt+ArrowDown" },
  { id: "diff.prev", label: "Previous change", group: "Diff", default: "Alt+ArrowUp" },
  // Scheme-independent alternates: ⌥↓/⌥↑ map to the Super key under the Linux
  // macOS-style keymap, so function keys give reliable change navigation there.
  { id: "diff.nextChange", label: "Next change (function key)", group: "Diff", default: "F3" },
  { id: "diff.prevChange", label: "Previous change (function key)", group: "Diff", default: "Shift+F3" },
  { id: "diff.revertBlock", label: "Revert current block", group: "Diff", default: "Alt+R" },
  { id: "diff.undo", label: "Undo", group: "Diff", default: "Mod+Z", scope: "diff" },
  { id: "diff.redo", label: "Redo", group: "Diff", default: "Mod+Shift+Z", scope: "diff" },
  { id: "diff.layout", label: "Toggle split / inline", group: "Diff", default: "Alt+L" },
  { id: "capture.snapshot", label: "Snapshot now", group: "Capture & revert", default: "Mod+Shift+S" },
  { id: "revert.file", label: "Revert file to point", group: "Capture & revert", default: "Mod+Alt+R" },
  { id: "file.copyPath", label: "Copy file path", group: "Changed files", default: "Mod+Shift+C" },
  { id: "file.copyContent", label: "Copy file contents", group: "Changed files", default: "Mod+Alt+C" },
  { id: "file.reveal", label: "Reveal in file manager", group: "Changed files", default: "Mod+Shift+E" },
  { id: "file.open", label: "Open file", group: "Changed files", default: "Mod+Shift+O" },
  { id: "file.focusInTree", label: "Focus opened file in tree", group: "Changed files", default: "Mod+O" },
  { id: "nav.history", label: "Go to History tab", group: "Navigation", default: "Mod+1" },
  { id: "nav.git", label: "Go to Git tab", group: "Navigation", default: "Mod+2" },
  { id: "nav.settings", label: "Go to Settings tab", group: "Navigation", default: "Mod+3" },
  // Back/forward avoid Mod+Alt+Arrow: that lands on physical Ctrl+Alt+Arrow,
  // which GNOME/KDE/XFCE reserve for workspace switching so it never reaches the
  // app. Minus/Equal (back/forward) are free and layout-stable.
  { id: "nav.back", label: "Navigate back", group: "Navigation", default: "Mod+Alt+-" },
  { id: "nav.forward", label: "Navigate forward", group: "Navigation", default: "Mod+Alt+=" },
  { id: "nav.nextPoint", label: "Next breaking point", group: "Navigation", default: "Alt+PageDown" },
  { id: "nav.prevPoint", label: "Previous breaking point", group: "Navigation", default: "Alt+PageUp" },
  { id: "terminal.toggle", label: "Toggle terminal", group: "Navigation", default: "Mod+T" },
  { id: "run.toggle", label: "Toggle run panel", group: "Navigation", default: "Mod+Shift+P" },
  { id: "settings.palette", label: "Open settings palette", group: "Navigation", default: "Mod+," },
  // Debug bindings follow JetBrains defaults (F8/F7/⇧F8/F9).
  { id: "debug.toggleBreakpoint", label: "Toggle breakpoint at cursor", group: "Debug", default: "Mod+F8" },
  { id: "debug.stepOver", label: "Step over", group: "Debug", default: "F8" },
  { id: "debug.stepInto", label: "Step into", group: "Debug", default: "F7" },
  { id: "debug.stepOut", label: "Step out", group: "Debug", default: "Shift+F8" },
  { id: "debug.resume", label: "Resume program", group: "Debug", default: "F9" },
  { id: "debug.stop", label: "Stop debug session", group: "Debug", default: "Mod+F2" },
  // Mod+Shift+D is freed for duplicate-line on Linux; the panel toggle uses B.
  { id: "debug.panel", label: "Toggle debug panel", group: "Debug", default: "Mod+Shift+B" },
  { id: "search.quickOpen", label: "Find files & folders", group: "Search", default: DOUBLE_SHIFT },
  { id: "search.text", label: "Find in files", group: "Search", default: "Mod+Shift+F" },
  // Replace-in-files on Mod+Shift+R (⌘⇧R / ⌥⇧R). test.run moved off Ctrl+Shift+R
  // so the two no longer collide on the same physical chord under the PC keymap.
  { id: "search.replace", label: "Replace in files", group: "Search", default: "Mod+Shift+R" },
];

const STORE_KEY = "ff.shortcuts";

// Per-scheme default overrides for mac-on-PC only. The ⌥ token maps to the Super
// key there, and GNOME/KDE hard-grab Super+arrow / Super+PageUp-Down / Super+L /
// Super+R (maximize, workspace switch, screen lock, KRunner) before the webview
// ever sees them — so these ⌥ defaults are dead on Linux. Re-anchor them onto the
// physical Alt key (the "Mod"/⌘ key here), which the WM does not reserve, keeping
// the canonical pc / native / real-mac defaults in ACTIONS untouched. Users can
// still rebind freely; resetting an action returns it to the value below.
const MAC_EMU_DEFAULTS: Record<string, string> = {
  "diff.next": "Mod+Shift+ArrowDown",
  "diff.prev": "Mod+Shift+ArrowUp",
  "diff.layout": "Mod+Shift+\\",
  "diff.revertBlock": "Mod+Shift+Backspace",
  "nav.nextPoint": "Mod+PageDown",
  "nav.prevPoint": "Mod+PageUp",
};

/** A resolved scheme: how physical modifiers map to the logical Mod/Alt tokens,
 *  how those tokens render, and which Monaco modifier each maps to. Canonical
 *  combo strings ("Mod+S", "Alt+D") never change — only this mapping does. */
interface Scheme {
  matchMod: (e: KeyboardEvent) => boolean;
  matchAlt: (e: KeyboardEvent) => boolean;
  // Detects the literal ⌃ Ctrl token. Only set where physical Ctrl is distinct
  // from Mod (mac-on-PC: Mod is Alt, Ctrl is the physical Ctrl key) so it can be
  // serialized for matching and the rebind / find-by-key UI. In pc/native, Ctrl
  // *is* Mod, so leaving this unset avoids emitting both tokens for one keypress.
  matchCtrl?: (e: KeyboardEvent) => boolean;
  mod: string;
  alt: string;
  shift: string;
  ctrl: string;
  sep: string;
  // Monaco KeyMod names (resolved against the monaco namespace in toKeybinding).
  // Monaco maps these to physical keys by the OS it detects (see
  // platform.js / keybindings.js): on a Mac-detecting Monaco CtrlCmd→⌘ and
  // WinCtrl→physical Ctrl; on Linux/Windows CtrlCmd→physical Ctrl and
  // WinCtrl→the Meta/Super key. So "physical Ctrl" is CtrlCmd or WinCtrl
  // depending on what Monaco sees — keyed off monacoSeesMac below. Alt is the
  // physical Alt key on every OS.
  monacoMod: "CtrlCmd" | "Alt" | "WinCtrl";
  monacoAlt: "Alt" | "WinCtrl" | "CtrlCmd";
  // True only for mac-style on a non-Mac host (the mac-on-PC emulation). Drives
  // two PC-keyboard fixes: (1) the global handler bridges ⌘C/⌘X/⌘V/⌘A/⌘Z to the
  // focused field, since off Mac the webview's native clipboard answers only
  // physical Ctrl, not the physical Alt key that now carries ⌘ (handleMacClipboard);
  // (2) actions whose ⌥ (Super) chord the window manager reserves are remapped to a
  // deliverable physical-Alt chord (MAC_EMU_DEFAULTS, applied in comboFor).
  macEmu?: boolean;
}

export function resolveScheme(style: KeymapStyle, hostIsMac: boolean): Scheme {
  const effective = style === "native" ? (hostIsMac ? "mac" : "pc") : style;
  if (effective === "pc") {
    return {
      matchMod: (e) => e.metaKey || e.ctrlKey,
      matchAlt: (e) => e.altKey,
      mod: "Ctrl",
      alt: "Alt",
      shift: "Shift",
      ctrl: "Ctrl",
      sep: "+",
      // Bind editor commands to whichever Monaco KeyMod resolves to the
      // *physical* Ctrl key for the OS Monaco actually detected: CtrlCmd when it
      // sees Linux/Windows (the normal case — fixPlatform strips the Mac token
      // from WebKitGTK's masquerading userAgent), WinCtrl only when that patch
      // failed and Monaco still thinks it is macOS. Picking the wrong one lands
      // every editor shortcut (save, format, …) on the unused Meta/Super key.
      monacoMod: monacoSeesMac ? "WinCtrl" : "CtrlCmd",
      monacoAlt: "Alt",
    };
  }
  if (hostIsMac) {
    // mac scheme on a real Mac: ⌘ and ⌥ are distinct physical keys.
    return {
      matchMod: (e) => e.metaKey || e.ctrlKey,
      matchAlt: (e) => e.altKey,
      mod: "⌘",
      alt: "⌥",
      shift: "⇧",
      ctrl: "⌃",
      sep: " ",
      monacoMod: "CtrlCmd",
      monacoAlt: "Alt",
    };
  }
  // mac scheme on a PC keyboard: emulate macOS. The keys flanking the spacebar
  // (physically Left/Right Alt) act as ⌘ (Mod) — they sit where ⌘ does on a Mac;
  // the Super/Win key acts as ⌥ (Option); physical Ctrl stays ⌃ (Control). Fn —
  // Option's real home on a Mac — never reaches the webview (no event/flag), so
  // Option lives on Super. There is no ⌘/⌥ keycap here, so label modifiers by the
  // physical key the user actually presses (Alt for ⌘, Super for ⌥, Ctrl for ⌃).
  return {
    matchMod: (e) => e.altKey,
    matchAlt: (e) => e.metaKey,
    matchCtrl: (e) => e.ctrlKey,
    mod: "Alt",
    alt: "Super",
    shift: "Shift",
    ctrl: "Ctrl",
    sep: "+",
    monacoMod: "Alt",
    // ⌥ (Option) is the Super/Meta key; bind it to the Monaco KeyMod that
    // resolves to Meta/Super for the OS Monaco detected — WinCtrl on Linux/Windows
    // (the normal case, fixPlatform strips the Mac token), CtrlCmd when that patch
    // failed and Monaco still sees macOS. The literal ⌃ Ctrl token takes the
    // opposite KeyMod (physical Ctrl) — see ctrlFlag in FileView's toKeybinding.
    monacoAlt: monacoSeesMac ? "CtrlCmd" : "WinCtrl",
    macEmu: true,
  };
}

let scheme: Scheme = resolveScheme(getPrefs().keymapStyle, IS_MAC);

/** Monaco modifier names for the active scheme, consumed by toKeybinding. */
export function monacoModifiers(): { mod: Scheme["monacoMod"]; alt: Scheme["monacoAlt"] } {
  return { mod: scheme.monacoMod, alt: scheme.monacoAlt };
}

type KeyMap = Record<string, string>;

let overrides: KeyMap = load();
const registry = new Map<string, () => void>();
const subscribers = new Set<() => void>();
let capturing: ((combo: string) => void) | null = null;

// Recompute the active scheme when the keymap style changes and refresh every
// subscriber so the modal and rendered combo hints follow the new scheme.
let lastStyle: KeymapStyle = getPrefs().keymapStyle;
subscribePrefs(() => {
  const style = getPrefs().keymapStyle;
  if (style === lastStyle) return;
  lastStyle = style;
  scheme = resolveScheme(style, IS_MAC);
  subscribers.forEach((fn) => fn());
});

function load(): KeyMap {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  subscribers.forEach((fn) => fn());
}

/** The default combo for an action under the active scheme: the mac-on-PC
 *  override when present, else the canonical ACTIONS default. */
function defaultCombo(id: string): string {
  if (scheme.macEmu && id in MAC_EMU_DEFAULTS) return MAC_EMU_DEFAULTS[id];
  return ACTIONS.find((a) => a.id === id)?.default ?? "";
}

export function comboFor(id: string): string {
  if (id in overrides) return overrides[id];
  return defaultCombo(id);
}

export function setCombo(id: string, combo: string) {
  if (!combo || combo === defaultCombo(id)) delete overrides[id];
  else overrides[id] = combo;
  persist();
}

export function resetCombo(id: string) {
  delete overrides[id];
  persist();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Shift produces a different character on US layouts ("{", "_", "+", …); used
// only as a fallback when an event carries no usable e.code (rare / synthetic).
const SHIFTED: Record<string, string> = {
  "{": "[", "}": "]", "_": "-", "+": "=", "?": "/", ":": ";", '"': "'",
  "<": ",", ">": ".", "|": "\\", "~": "`",
  ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
  "&": "7", "*": "8", "(": "9",
};

// Physical-position (e.code) → canonical combo key, labelled with US keycaps.
// Combos are matched by *position* like Monaco's keybindings (which key off
// KeyCode), so they stay identical across keyboard layouts: e.g. "Mod+/" fires
// on whatever key sits where US "/" is, even when that glyph needs Shift/AltGr
// on the active layout. Numpad +/−/= alias to "="/"-" so they zoom too.
const CODE_KEY: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  Comma: ",", Period: ".", Slash: "/", Space: "Space",
  NumpadAdd: "=", NumpadSubtract: "-", NumpadDecimal: ".",
  NumpadDivide: "/", NumpadMultiply: "*", NumpadEqual: "=",
};

// The character key for a combo, derived from the physical e.code so it is
// layout-independent. Falls back to the logical e.key (with US-shift fixup) for
// named keys (arrows, F-keys, Page…) and events lacking a code.
function keyFromCode(e: KeyboardEvent): string {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (code in CODE_KEY) return CODE_KEY[code];
  let key = e.key;
  if (key === " ") key = "Space";
  if (key in SHIFTED) key = SHIFTED[key];
  if (key.length === 1) key = key.toUpperCase();
  return key;
}

/** Serializes a keydown into a comparable combo string, or "" for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return "";
  const parts: string[] = [];
  if (scheme.matchMod(e)) parts.push("Mod");
  if (scheme.matchCtrl?.(e)) parts.push("Ctrl");
  if (scheme.matchAlt(e)) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(keyFromCode(e));
  return parts.join("+");
}

// Style-independent display names; Mod/Alt/Shift come from the active scheme.
const SYMBOL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

function render(combo: string, s: Scheme): string {
  if (!combo) return "—";
  if (combo === DOUBLE_SHIFT) return `${s.shift} ${s.shift}`;
  const modifiers: Record<string, string> = { Mod: s.mod, Alt: s.alt, Shift: s.shift, Ctrl: s.ctrl };
  return combo
    .split("+")
    .map((p) => modifiers[p] ?? SYMBOL[p] ?? p)
    .join(s.sep);
}

export function formatCombo(combo: string): string {
  return render(combo, scheme);
}

/** Render a combo as a given style would show it (for style-picker previews),
 *  without changing the active scheme. */
export function formatComboFor(combo: string, style: KeymapStyle): string {
  return render(combo, resolveScheme(style, IS_MAC));
}

function inTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function isInputLike(el: HTMLElement | null): el is HTMLInputElement | HTMLTextAreaElement {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}
function isEditable(el: HTMLElement | null): boolean {
  return isInputLike(el) || !!el?.isContentEditable;
}

// ⌘-clipboard on a PC keyboard: the native copy/paste shortcut on Linux/Windows
// is physical Ctrl, but mac-emulation puts ⌘ on the physical Alt key, so ⌘C/⌘V/…
// never reach the webview's built-in editing outside Monaco. Bridge them onto the
// focused field. WebKitGTK blocks execCommand("copy"/"cut"/"paste"), so the actual
// clipboard read/write goes through the Tauri plugin (Rust); only the *editing*
// side (delete on cut, insert on paste, select) uses execCommand, which WebKitGTK
// does honour — and routes through the editing pipeline so React's onChange fires.
const CLIPBOARD_OPS: Record<string, "copy" | "cut" | "paste" | "selectAll" | "undo" | "redo"> = {
  "Mod+C": "copy",
  "Mod+X": "cut",
  "Mod+V": "paste",
  "Mod+A": "selectAll",
  "Mod+Z": "undo",
  "Mod+Shift+Z": "redo",
};

/** Text currently selected in the focused field (or the page selection). */
function selectedText(el: HTMLElement | null): string {
  if (isInputLike(el)) {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }
  return window.getSelection?.()?.toString() ?? "";
}

async function clipWrite(text: string) {
  try {
    await writeText(text);
  } catch (err) {
    dbg("mac clipboard write failed; falling back to execCommand", String(err));
    document.execCommand("copy");
  }
}

async function macPaste() {
  let text = "";
  try {
    text = (await readText()) ?? "";
  } catch (err) {
    dbg("mac clipboard read failed", String(err));
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
  }
  if (text) document.execCommand("insertText", false, text);
}

/** Bridges a ⌘ clipboard combo to the focused field under mac-emulation. Returns
 *  true when it handled the combo (caller then stops the event). Monaco and the
 *  terminal own their clipboard, so it defers to them. */
function handleMacClipboard(combo: string): boolean {
  const op = CLIPBOARD_OPS[combo];
  if (!op) return false;
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest(".monaco-editor") || el?.closest(".xterm")) return false;
  if (op === "selectAll") {
    if (isInputLike(el)) el.select();
    else if (isEditable(el)) document.execCommand("selectAll");
    else return false;
    return true;
  }
  if (op === "undo" || op === "redo") {
    if (!isEditable(el)) return false;
    document.execCommand(op);
    return true;
  }
  if (op === "paste") {
    if (!isEditable(el)) return false;
    void macPaste();
    return true;
  }
  // copy / cut: write the live selection via the plugin; cut also deletes it.
  const sel = selectedText(el);
  if (!sel) return true;
  void clipWrite(sel);
  if (op === "cut" && isEditable(el)) document.execCommand("delete");
  dbg("mac clipboard", op, `${sel.length} chars`);
  return true;
}

/** Listens for the next real combo and reports it once (used by the rebind UI). */
export function beginCapture(onCombo: (combo: string) => void): () => void {
  capturing = onCombo;
  return () => {
    capturing = null;
  };
}

const DOUBLE_SHIFT_MS = 400;
let lastShiftAt = 0;

function fireDoubleShift(e: KeyboardEvent) {
  const action = ACTIONS.find((a) => comboFor(a.id) === DOUBLE_SHIFT);
  if (!action) return;
  // Never steal Shift from a focused terminal.
  if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
  const handler = registry.get(action.id);
  if (!handler) return;
  e.preventDefault();
  e.stopPropagation();
  handler();
}

function onKeyDown(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  // Double-Shift: two bare Shift presses with nothing in between. A held key
  // (repeat) or any other key/modifier resets the sequence, so Shift-typing
  // capitals never triggers it.
  if (e.key === "Shift" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !capturing) {
    const now = performance.now();
    if (now - lastShiftAt < DOUBLE_SHIFT_MS) {
      lastShiftAt = 0;
      fireDoubleShift(e);
    } else {
      lastShiftAt = now;
    }
    return;
  }
  lastShiftAt = 0;
  if (!combo) return;
  if (DEBUG) {
    dbg("keydown", { key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, combo });
  }
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    const cb = capturing;
    capturing = null;
    cb(combo);
    return;
  }
  // mac-emulation: route ⌘C/⌘X/⌘V/⌘A/⌘Z (physical Alt) to the focused field,
  // since the webview's native clipboard only answers physical Ctrl off Mac.
  if (scheme.macEmu && handleMacClipboard(combo)) {
    dbg("mac clipboard handled", combo);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // Don't hijack plain typing in inputs/editors; only modified combos and
  // function keys (debug stepping) fire there.
  if (inTextField() && !/(^|\+)(Mod|Alt)(\+|$)/.test(combo) && !/^(Shift\+)?F\d+$/.test(combo)) {
    dbg("skip", combo, "— plain key in a text field");
    return;
  }
  const action = ACTIONS.find((a) => comboFor(a.id) === combo);
  if (!action) {
    dbg("no action bound to", combo);
    return;
  }
  const el = document.activeElement as HTMLElement | null;
  // While a terminal is focused, only the toggle fires; every other combo goes
  // to the shell (Ctrl-C, Ctrl-R, etc.).
  if (action.id !== "terminal.toggle" && el?.closest(".xterm")) {
    dbg("skip", action.id, "— terminal focused");
    return;
  }
  // Diff-scoped bindings (undo/redo) only act when the *diff* editor is focused,
  // so they don't steal ⌘Z / Ctrl+Z from the plain file editor (which shares the
  // editor-wrap class) or the commit box. The diff editor alone carries diff-wrap.
  if (action.scope === "diff" && !el?.closest(".diff-wrap")) {
    dbg("skip", action.id, "— diff-scoped but diff editor not focused");
    return;
  }
  const handler = registry.get(action.id);
  if (!handler) {
    dbg("matched", action.id, "but no handler registered (owning component unmounted / not using useShortcut)");
    return;
  }
  dbg("fire", action.id);
  // Capture-phase stop so the focused control (e.g. Monaco) doesn't also act.
  e.preventDefault();
  e.stopPropagation();
  handler();
}

let installed = false;
export function installShortcuts() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  (window as unknown as { ffShortcutsDebug?: (on?: boolean) => object }).ffShortcutsDebug = (on?: boolean) => {
    if (typeof on === "boolean") {
      DEBUG = on;
      try {
        if (on) localStorage.setItem("ff.debugShortcuts", "1");
        else localStorage.removeItem("ff.debugShortcuts");
      } catch {
        // localStorage unavailable: in-memory toggle still applies this session.
      }
    }
    const snap = detectionSnapshot();
    console.table(snap);
    return snap;
  };
  if (DEBUG) {
    console.log("%c[shortcuts] detection", "color:#7c3aed;font-weight:bold");
    console.table(detectionSnapshot());
  }
}

/** Registers a handler for an action while the calling component is mounted. */
export function useShortcut(id: string, handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    registry.set(id, handler);
    return () => {
      if (registry.get(id) === handler) registry.delete(id);
    };
  }, [id, handler, enabled]);
}

// Minimal ANSI SGR parser for the Run panel console (the terminal uses xterm,
// which already handles this; the run output is a plain DOM console). Programs
// like structured Go loggers emit `\x1b[35mDEBUG\x1b[0m` etc.; without parsing,
// the escape bytes render as garbage boxes. We handle SGR color/weight codes and
// strip every other escape/control sequence.

export interface AnsiSpan {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

// 16-colour palette tuned for a dark console (Tokyo Night family — matches the
// default theme; ANSI colours are conventionally fixed rather than themed).
const FG: Record<number, string> = {
  30: "#414868", 31: "#f7768e", 32: "#9ece6a", 33: "#e0af68",
  34: "#7aa2f7", 35: "#bb9af7", 36: "#7dcfff", 37: "#a9b1d6",
  90: "#565f89", 91: "#ff7a93", 92: "#b9f27c", 93: "#ff9e64",
  94: "#7da6ff", 95: "#c7a9ff", 96: "#0db9d7", 97: "#c0caf5",
};

// Non-SGR escapes (cursor moves, OSC titles, …) and stray control bytes —
// dropped so they never reach the DOM. Tab and newline are preserved.
const STRIP = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-9;?]*[A-PR-Za-ln-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let color: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let underline = false;

  for (const part of input.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part) continue;
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (sgr) {
      const codes = sgr[1] === "" ? [0] : sgr[1].split(";").map(Number);
      for (const c of codes) {
        if (c === 0) { color = bg = undefined; bold = dim = underline = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 4) underline = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 24) underline = false;
        else if (c === 39) color = undefined;
        else if (c === 49) bg = undefined;
        else if (c in FG) color = FG[c];
        // Background colours (40-47, 100-107) share the foreground palette.
        else if (c - 10 in FG && ((c >= 40 && c <= 47) || (c >= 100 && c <= 107))) bg = FG[c - 10];
        // Bright a normal colour when bold is set, matching most terminals.
        if (bold && color && c >= 30 && c <= 37 && c + 60 in FG) color = FG[c + 60];
      }
      continue;
    }
    const text = part.replace(STRIP, "");
    if (text) spans.push({ text, color, bg, bold, dim, underline });
  }
  return spans;
}

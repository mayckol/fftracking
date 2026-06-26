import type { MergeBlock } from "../../lib/types";
import type { Decision, Side } from "./types";

// ── pure merge core (no React, no Monaco) ───────────────────────────────────
// Positional truth is a single integer array `lineCount[]` (one slot per block,
// change AND unchanged). Each block's live result span is a prefix-sum, so there
// are zero positioning decorations: a 0-line region is just `lineCount[i]===0`
// (an insertion point before its start), not a special collapsed anchor.

export const isChange = (b: MergeBlock) => b.kind !== "unchanged";

export function sideLines(b: MergeBlock, side: Side): string[] {
  if (b.kind === "unchanged") return b.base;
  return side === "ours" ? b.ours : b.theirs;
}

// Pre-resolution contribution: every change auto-applied, conflict defaulting to
// ours — exactly git's pre-merge buffer minus the markers.
export function defaultLines(b: MergeBlock): string[] {
  if (b.kind === "unchanged") return b.base;
  if (b.kind === "theirs") return b.theirs;
  return b.ours; // ours / both / conflict
}

// Lines a block contributes for a decision. NOT valid for `manual` (its content
// lives in the model); callers must never re-derive a manual block.
export function linesFor(b: MergeBlock, d: Decision): string[] {
  switch (d.kind) {
    case "default":
      return defaultLines(b);
    case "skip":
      return b.base;
    case "side": {
      const primary = sideLines(b, d.side);
      if (!d.append) return primary;
      const other: Side = d.side === "ours" ? "theirs" : "ours";
      return [...sideLines(b, other), ...primary];
    }
    case "manual":
      return [];
  }
}

export const initDecision = (): Decision => ({ kind: "default" });

// A change is relevant to a side pane only if that side actually changed it.
export function relevant(b: MergeBlock, side: Side): boolean {
  if (!isChange(b)) return false;
  return side === "ours" ? b.kind !== "theirs" : b.kind !== "ours";
}

// 1-based start line of each block; `starts[n]` = line after the last block.
// Span of block i = [starts[i], starts[i]+lineCount[i]-1]; when lineCount[i]===0
// it is an insertion point before line starts[i].
export function prefixStarts(lineCount: number[]): number[] {
  const starts = new Array<number>(lineCount.length + 1);
  starts[0] = 1;
  for (let i = 0; i < lineCount.length; i++) starts[i + 1] = starts[i] + lineCount[i];
  return starts;
}

// Block owning a 1-based line. Zero-length blocks (starts[i]===starts[i+1]) are
// skipped naturally; a line past the end maps to the last block.
export function blockAt(starts: number[], line: number): number {
  for (let i = 0; i < starts.length - 1; i++) {
    if (starts[i] <= line && line < starts[i + 1]) return i;
  }
  return Math.max(0, starts.length - 2);
}

export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Monaco models an empty buffer as 1 (empty) line; treat that as 0 result lines so
// `Σ lineCount === modelLineCount` holds across the empty case.
export function modelLineCount(value: string, monacoLineCount: number): number {
  return value === "" ? 0 : monacoLineCount;
}

// Apply manual-edit line deltas to lineCount. Each change is attributed to the
// block at its start line; deletions cascade forward so totals always equal the
// model's line count (Σ lineCount is preserved by construction). Single-block edits
// — the overwhelming common case — are exact; a rare boundary-spanning edit may
// shift a connector but never loses content (the text lives in the model).
export function reconcile(
  prevLineCount: number[],
  blocks: MergeBlock[],
  changes: { range: { startLineNumber: number; endLineNumber: number }; text: string }[],
): { lineCount: number[]; touched: number[] } {
  const lc = prevLineCount.slice();
  const starts = prefixStarts(prevLineCount);
  const touched = new Set<number>();
  for (const c of changes) {
    const delta = countNewlines(c.text) - (c.range.endLineNumber - c.range.startLineNumber);
    let i = blockAt(starts, c.range.startLineNumber);
    touched.add(i);
    if (delta >= 0) {
      lc[i] += delta;
    } else {
      let rem = -delta;
      while (rem > 0 && i < lc.length) {
        const take = Math.min(lc[i], rem);
        lc[i] -= take;
        rem -= take;
        touched.add(i);
        i++;
      }
    }
  }
  return { lineCount: lc, touched: [...touched].filter((i) => i < blocks.length && isChange(blocks[i])) };
}

// True when a side contributes zero lines across EVERY block — the modify/delete
// signature (the file was removed on that side). Resolving such a conflict to an
// empty result must route through gitAcceptSide so the backend removes the file
// instead of writing "" (which truncates it).
export function isWholeSideAbsent(blocks: MergeBlock[], side: Side): boolean {
  return blocks.length > 0 && blocks.every((b) => sideLines(b, side).length === 0);
}

export type BandClass = "ours" | "theirs" | "conflict" | "both" | "edited" | null;

// Band tone for a change's RESULT region.
export function resClass(b: MergeBlock, d: Decision): BandClass {
  if (!isChange(b)) return null;
  if (d.kind === "manual") return "edited";
  if (d.kind === "skip") return null; // base taken — neutral
  if (d.kind === "side") return d.side;
  // default
  if (b.kind === "conflict") return "conflict";
  return b.kind as BandClass; // ours / theirs / both
}

// Whether a side pane's band + action buttons still show for a change.
export function isPending(d: Decision): boolean {
  return d.kind === "default";
}

// A conflict with one side already taken (not appended) — clicking the other side
// keeps both.
export function appendEligible(b: MergeBlock, side: Side, d: Decision): boolean {
  if (b.kind !== "conflict") return false;
  const other: Side = side === "ours" ? "theirs" : "ours";
  return d.kind === "side" && d.side === other && !d.append;
}

// Band tone for a side pane region (or null to hide it).
export function sideClass(b: MergeBlock, side: Side, d: Decision): BandClass {
  if (!relevant(b, side)) return null;
  if (!(isPending(d) || appendEligible(b, side, d))) return null;
  return b.kind === "conflict" ? "conflict" : side;
}

export function bandHeight(b: MergeBlock, resLen: number): number {
  return Math.max(sideLines(b, "ours").length, sideLines(b, "theirs").length, resLen);
}

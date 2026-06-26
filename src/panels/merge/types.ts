import type { MergeBlock } from "../../lib/types";

export type Side = "ours" | "theirs";

// Per-block resolution decision. The Monaco result model holds the actual merged
// text; `Decision[]` is the parallel metadata truth (what each block currently is).
//  - default: auto-applied default — unchanged→base, ours/both→that change, theirs→
//    theirs, conflict→ours but UNRESOLVED (a conflict still at `default` counts as
//    "remaining").
//  - side: resolved to one side; `append` keeps both (other side first, then this).
//  - skip: take base (ignore the change).
//  - manual: the user hand-edited this block's region; its content lives only in the
//    model, never re-derived.
export type Decision =
  | { kind: "default" }
  | { kind: "side"; side: Side; append?: boolean }
  | { kind: "skip" }
  | { kind: "manual" };

// Per alternativeVersionId snapshot, so undo/redo restores resolution metadata in
// lockstep with Monaco's native text undo. `editSeq` co-keys against altId reuse
// (identical text recurring with different decisions).
export interface Snapshot {
  decisions: Decision[];
  lineCounts: number[];
  editSeq: number;
}

export type { MergeBlock };

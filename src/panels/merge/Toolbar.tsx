import type { Side } from "./types";

interface Props {
  oursLabel: string;
  theirsLabel: string;
  changeCount: number;
  remaining: number;
  collapsed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onApplyAll: (side: Side) => void;
  onApplyAllBoth: () => void;
  onWand: () => void;
  onToggleCollapse: () => void;
}

// Single JetBrains-style toolbar row. The whitespace/granularity dropdowns, the
// split toggle and the kebab are cosmetic stubs over the fixed diff3 backend (it
// cannot re-diff); the magic-wand is real (auto-applies non-conflicting changes).
export default function Toolbar({
  oursLabel,
  theirsLabel,
  changeCount,
  remaining,
  collapsed,
  onPrev,
  onNext,
  onApplyAll,
  onApplyAllBoth,
  onWand,
  onToggleCollapse,
}: Props) {
  return (
    <div className="mrg-toolbar">
      <div className="mrg-tb-group">
        <button className="mrg-iconbtn" title="Previous change (Shift+F7)" onClick={onPrev}>
          ↑
        </button>
        <button className="mrg-iconbtn" title="Next change (F7)" onClick={onNext}>
          ↓
        </button>
      </div>

      <span className="mrg-tb-sep" />

      <span className="mrg-tb-label">Apply non-conflicting changes:</span>
      <button className="mrg-applybtn" title={`Apply all from ${oursLabel}`} onClick={() => onApplyAll("ours")}>
        <span className="mrg-chev ours">≫</span> Left
      </button>
      <button className="mrg-applybtn" title="Apply all non-conflicting changes" onClick={onApplyAllBoth}>
        All
      </button>
      <button className="mrg-applybtn" title={`Apply all from ${theirsLabel}`} onClick={() => onApplyAll("theirs")}>
        <span className="mrg-chev theirs">≪</span> Right
      </button>
      <button className="mrg-iconbtn accent" title="Resolve simple conflicts" onClick={onWand}>
        🪄
      </button>

      <span className="mrg-tb-sep" />

      <button className="mrg-dropdown" title="Whitespace policy" disabled>
        Do not ignore <span className="mrg-caret">▾</span>
      </button>
      <button className="mrg-dropdown" title="Diff granularity" disabled>
        Highlight words <span className="mrg-caret">▾</span>
      </button>
      <button
        className={`mrg-iconbtn toggle${collapsed ? " on" : ""}`}
        title="Collapse unchanged fragments"
        onClick={onToggleCollapse}
      >
        ⊟
      </button>

      <span className="mrg-tb-status">
        <b>{changeCount}</b> change{changeCount === 1 ? "" : "s"}.{" "}
        <b className={remaining ? "bad" : ""}>{remaining}</b> conflict{remaining === 1 ? "" : "s"}.
      </span>
    </div>
  );
}

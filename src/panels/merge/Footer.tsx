import type { Side } from "./types";

interface Props {
  busy: boolean;
  changeCount: number;
  onAcceptAll: (side: Side) => void;
  onCancel: () => void;
  onApply: () => void;
}

export default function Footer({ busy, changeCount, onAcceptAll, onCancel, onApply }: Props) {
  return (
    <div className="mrg-foot">
      <div className="mrg-foot-l">
        <button className="tbtn" disabled={busy} onClick={() => onAcceptAll("ours")}>
          Accept Left
        </button>
        <button className="tbtn" disabled={busy} onClick={() => onAcceptAll("theirs")}>
          Accept Right
        </button>
      </div>
      <div className="mrg-foot-r">
        <button className="tbtn" onClick={onCancel}>
          Cancel
        </button>
        <button className="tbtn primary" disabled={changeCount === 0} title="Apply the merge and close" onClick={onApply}>
          Apply
        </button>
      </div>
    </div>
  );
}

interface Props {
  oursLabel: string;
  theirsLabel: string;
  relPath: string;
  path: string;
  w: [number, number, number];
}

// Three column headers aligned to the pane weights, with two empty spacers filling
// the gutter columns so the cells line up pixel-for-pixel with the editors. Side
// panes carry a 🔒 (read-only); the result never does.
export default function Headers({ oursLabel, theirsLabel, relPath, path, w }: Props) {
  return (
    <div className="mrg-heads">
      <div className="mrg-head ours" style={{ flexGrow: w[0] }}>
        <span className="mrg-lock" title="Read-only">
          🔒
        </span>
        <span className="mrg-head-ref" title={oursLabel}>
          {oursLabel}
        </span>
        <button className="mrg-details" disabled>
          Show Details
        </button>
      </div>
      <div className="mrg-head-gut" />
      <div className="mrg-head result" style={{ flexGrow: w[1] }}>
        <span className="mrg-head-title">Result</span>
        <span className="mrg-head-path" title={path}>
          {relPath}
        </span>
      </div>
      <div className="mrg-head-gut" />
      <div className="mrg-head theirs" style={{ flexGrow: w[2] }}>
        <span className="mrg-lock" title="Read-only">
          🔒
        </span>
        <span className="mrg-head-ref" title={theirsLabel}>
          {theirsLabel}
        </span>
        <button className="mrg-details" disabled>
          Show Details
        </button>
      </div>
    </div>
  );
}

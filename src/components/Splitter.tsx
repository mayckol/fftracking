import { useCallback } from "react";

interface Props {
  dir: "x" | "y";
  onDelta: (delta: number) => void;
}

// Drag handle that reports incremental pointer movement; the parent owns the
// size state and clamps it. "x" resizes width (col-resize), "y" height.
export default function Splitter({ dir, onDelta }: Props) {
  const down = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      let last = dir === "x" ? e.clientX : e.clientY;
      const move = (ev: MouseEvent) => {
        const p = dir === "x" ? ev.clientX : ev.clientY;
        onDelta(p - last);
        last = p;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      document.body.style.cursor = dir === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [dir, onDelta],
  );

  return <div className={`splitter ${dir}`} onMouseDown={down} />;
}

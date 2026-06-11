import { useRef, useState } from "react";
import Terminal from "../components/Terminal";
import Splitter from "../components/Splitter";

interface Props {
  cwd: string | null;
  height: number;
  onResize: (delta: number) => void;
  onClose: () => void;
}

export default function TerminalPanel({ cwd, height, onResize, onClose }: Props) {
  const nextId = useRef(2);
  const [tabs, setTabs] = useState<number[]>([1]);
  const [active, setActive] = useState(1);

  const addTab = () => {
    const id = nextId.current++;
    setTabs((t) => [...t, id]);
    setActive(id);
  };

  const closeTab = (id: number) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t !== id);
      if (next.length === 0) {
        onClose();
        return prev;
      }
      if (id === active) {
        const i = prev.indexOf(id);
        setActive(next[Math.min(i, next.length - 1)]);
      }
      return next;
    });
  };

  return (
    <div className="term-panel" style={{ height }}>
      <Splitter dir="y" onDelta={onResize} />
      <div className="term-bar">
        <div className="term-tabs">
          {tabs.map((id, i) => (
            <div
              key={id}
              className={`term-tab${id === active ? " on" : ""}`}
              onClick={() => setActive(id)}
              title={`Terminal ${i + 1}`}
            >
              <span>{`Terminal ${i + 1}`}</span>
              <button
                className="term-tab-x"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="term-new" title="New terminal" onClick={addTab}>
            ＋
          </button>
        </div>
        <button className="term-close" title="Close terminal (toggle)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="term-body">
        {tabs.map((id) => (
          <div key={id} className="term-slot" style={{ display: id === active ? "block" : "none" }}>
            <Terminal cwd={cwd} active={id === active} onExit={() => closeTab(id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

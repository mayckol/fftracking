import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Per-row style — used for font-family previews in the options list. */
  optionStyle?: CSSProperties;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  width?: number;
  /** Applied to the trigger button — mirrors the selected option's font preview. */
  triggerStyle?: CSSProperties;
  ariaLabel?: string;
}

export default function Select({ value, options, onChange, width, triggerStyle, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const selectedIdx = options.findIndex((o) => o.value === value);
  const current = options[selectedIdx] ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, selectedIdx]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (i: number) => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>(".ff-select-trigger")?.focus();
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(options.length - 1, a + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
    }
  }

  return (
    <div className="ff-select" ref={ref} style={width ? { width } : undefined}>
      <button
        type="button"
        className="ff-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={triggerStyle}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="ff-select-cur">{current?.label ?? value}</span>
        <span className="ff-select-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="ctx-backdrop" onClick={() => setOpen(false)} />
          <div
            className="ff-select-menu"
            role="listbox"
            ref={listRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {options.map((o, i) => (
              <button
                key={`${id}:${o.value}`}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-i={i}
                className={`ff-select-opt${o.value === value ? " on" : ""}${i === active ? " active" : ""}`}
                style={o.optionStyle}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

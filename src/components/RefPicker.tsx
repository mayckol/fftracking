import { useEffect, useMemo, useRef, useState } from "react";
import { WORKDIR } from "../lib/ipc";
import type { RefList } from "../lib/types";

type RefKind = "work" | "head" | "local" | "origin" | "commit";

interface RefItem {
  value: string;
  label: string;
  sub?: string;
  kind: RefKind;
}

interface RefGroup {
  title: string;
  items: RefItem[];
}

const BADGE: Record<RefKind, string> = {
  work: "✎",
  head: "⌂",
  local: "⎇",
  origin: "⇡",
  commit: "●",
};

function buildGroups(refs: RefList | null, includeWorkdir: boolean): RefGroup[] {
  const groups: RefGroup[] = [];
  const refsGroup: RefItem[] = [];
  if (includeWorkdir) refsGroup.push({ value: WORKDIR, label: "Working tree", kind: "work" });
  refsGroup.push({ value: "HEAD", label: "HEAD", kind: "head" });
  groups.push({ title: "References", items: refsGroup });

  if (refs?.branches.length) {
    groups.push({ title: "Local branches", items: refs.branches.map((b) => ({ value: b, label: b, kind: "local" })) });
  }
  if (refs?.remote_branches.length) {
    groups.push({ title: "Origin branches", items: refs.remote_branches.map((b) => ({ value: b, label: b, kind: "origin" })) });
  }
  if (refs?.commits.length) {
    groups.push({
      title: "Commits",
      items: refs.commits.map((c) => ({ value: c.id, label: c.summary, sub: c.id.slice(0, 8), kind: "commit" })),
    });
  }
  return groups;
}

function labelFor(value: string, refs: RefList | null): { text: string; kind: RefKind } {
  if (value === WORKDIR) return { text: "Working tree", kind: "work" };
  if (value === "HEAD") return { text: "HEAD", kind: "head" };
  const c = refs?.commits.find((x) => x.id === value);
  if (c) return { text: `${c.id.slice(0, 8)} · ${c.summary}`, kind: "commit" };
  if (refs?.remote_branches.includes(value)) return { text: value, kind: "origin" };
  return { text: value, kind: "local" };
}

interface Props {
  refs: RefList | null;
  value: string;
  onChange: (v: string) => void;
  includeWorkdir: boolean;
}

export default function RefPicker({ refs, value, onChange, includeWorkdir }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQ("");
  }, [open]);

  const groups = useMemo(() => buildGroups(refs, includeWorkdir), [refs, includeWorkdir]);
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (it) =>
              it.label.toLowerCase().includes(ql) ||
              it.value.toLowerCase().includes(ql) ||
              (it.sub ?? "").toLowerCase().includes(ql),
          ),
        }))
        .filter((g) => g.items.length)
    : groups;

  const cur = labelFor(value, refs);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="refpick">
      <button className="refpick-trigger" onClick={() => setOpen((o) => !o)} title={value}>
        <span className={`refpick-badge ${cur.kind}`}>{BADGE[cur.kind]}</span>
        <span className="refpick-cur">{cur.text}</span>
        <span className="refpick-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="ctx-backdrop" onClick={() => setOpen(false)} />
          <div className="refpick-menu" onClick={(e) => e.stopPropagation()}>
            <div className="refpick-head">
              <input
                ref={inputRef}
                value={q}
                placeholder="Filter branches & commits…"
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <div className="refpick-list">
              {filtered.length === 0 ? (
                <div className="refpick-empty">No matching refs</div>
              ) : (
                filtered.map((g) => (
                  <div className="refpick-group" key={g.title}>
                    <div className="refpick-gtitle">{g.title}</div>
                    {g.items.map((it) => (
                      <button
                        key={`${it.kind}:${it.value}`}
                        className={`refpick-row${it.value === value ? " on" : ""}`}
                        onClick={() => choose(it.value)}
                        title={it.value}
                      >
                        <span className={`refpick-badge ${it.kind}`}>{BADGE[it.kind]}</span>
                        <span className="refpick-label">{it.label}</span>
                        {it.sub && <span className="refpick-sub">{it.sub}</span>}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

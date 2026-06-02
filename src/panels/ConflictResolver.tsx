import { useEffect, useMemo, useState } from "react";
import { api, WORKDIR } from "../lib/ipc";
import { basename } from "../lib/util";

type Segment =
  | { kind: "ctx"; text: string }
  | { kind: "conflict"; ours: string; theirs: string };

function parse(raw: string): Segment[] {
  const lines = raw.split("\n");
  const segs: Segment[] = [];
  let ctx: string[] = [];
  let i = 0;
  const flush = () => {
    if (ctx.length) {
      segs.push({ kind: "ctx", text: ctx.join("\n") });
      ctx = [];
    }
  };
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      flush();
      i++;
      const ours: string[] = [];
      while (i < lines.length && !lines[i].startsWith("=======") && !lines[i].startsWith("|||||||")) {
        ours.push(lines[i++]);
      }
      // skip an optional diff3 base section
      while (i < lines.length && !lines[i].startsWith("=======")) i++;
      i++; // past =======
      const theirs: string[] = [];
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        theirs.push(lines[i++]);
      }
      i++; // past >>>>>>>
      segs.push({ kind: "conflict", ours: ours.join("\n"), theirs: theirs.join("\n") });
    } else {
      ctx.push(lines[i++]);
    }
  }
  flush();
  return segs;
}

type Choice = "ours" | "theirs" | "both";

interface Props {
  repoPath: string;
  path: string;
  toast: (msg: string, error?: boolean) => void;
  onResolved: () => void;
}

export default function ConflictResolver({ repoPath, path, toast, onResolved }: Props) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const raw = (await api.gitFile(repoPath, WORKDIR, path)) ?? "";
      if (!alive) return;
      const parsed = parse(raw);
      setSegs(parsed);
      const c: Record<number, Choice> = {};
      parsed.forEach((s, i) => {
        if (s.kind === "conflict") c[i] = "ours";
      });
      setChoices(c);
      setEdited(false);
    })();
    return () => {
      alive = false;
    };
  }, [repoPath, path]);

  const computed = useMemo(() => {
    return segs
      .map((s, i) => {
        if (s.kind === "ctx") return s.text;
        const c = choices[i] ?? "ours";
        if (c === "ours") return s.ours;
        if (c === "theirs") return s.theirs;
        return [s.ours, s.theirs].filter(Boolean).join("\n");
      })
      .join("\n");
  }, [segs, choices]);

  useEffect(() => {
    if (!edited) setText(computed);
  }, [computed, edited]);

  const conflictCount = segs.filter((s) => s.kind === "conflict").length;

  async function save() {
    try {
      await api.gitResolveConflict(repoPath, path, text);
      toast(`Resolved ${basename(path)}`);
      onResolved();
    } catch (e) {
      toast(String(e), true);
    }
  }

  let blockIdx = 0;
  return (
    <div className="col main">
      <div className="conflict-banner">
        ⚠ Merge conflict — {conflictCount} region(s) in <b style={{ marginLeft: 4 }}>{basename(path)}</b>
        <div className="diff-actions" style={{ marginLeft: "auto" }}>
          <button className="tbtn primary" onClick={save}>
            Mark resolved &amp; stage
          </button>
        </div>
      </div>
      <div className="pane">
        {segs.map((s, i) => {
          if (s.kind === "ctx") {
            const lines = s.text.split("\n");
            const head = lines.slice(0, 3);
            const more = lines.length - head.length;
            return (
              <div key={i}>
                {head.map((l, j) => (
                  <div className="ctx-line" key={j}>
                    {l || " "}
                  </div>
                ))}
                {more > 0 && <div className="ctx-line">… {more} more lines</div>}
              </div>
            );
          }
          const idx = i;
          const n = ++blockIdx;
          const c = choices[idx];
          return (
            <div className="hunk" key={i}>
              <div className="hunk-side ours">
                <div className="lbl">
                  ◀ Ours · region {n} {c === "ours" && "✓"}
                </div>
                <pre>{s.ours || "(empty)"}</pre>
              </div>
              <div className="hunk-side theirs">
                <div className="lbl">
                  Theirs ▶ {c === "theirs" && "✓"}
                </div>
                <pre>{s.theirs || "(empty)"}</pre>
              </div>
              <div className="hunk-acts">
                {(["ours", "theirs", "both"] as Choice[]).map((opt) => (
                  <button
                    key={opt}
                    className={`tbtn${c === opt ? " primary" : ""}`}
                    onClick={() => {
                      setChoices({ ...choices, [idx]: opt });
                      setEdited(false);
                    }}
                  >
                    {opt === "ours" ? "Accept ours" : opt === "theirs" ? "Accept theirs" : "Keep both"}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        <div className="section-title">Resolved result (editable)</div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setEdited(true);
          }}
          style={{ minHeight: 200 }}
        />
      </div>
    </div>
  );
}

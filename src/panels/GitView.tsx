import { useCallback, useEffect, useRef, useState } from "react";
import DiffEditor, { type DiffHandle } from "../components/DiffEditor";
import { api, WORKDIR } from "../lib/ipc";
import type { GitFileChange, HunkInfo, RefList } from "../lib/types";
import { basename, langOf } from "../lib/util";
import ChangedTree from "./ChangedTree";
import ConflictResolver from "./ConflictResolver";

interface Props {
  initialRepo: string | null;
  toast: (msg: string, error?: boolean) => void;
}

export default function GitView({ initialRepo, toast }: Props) {
  const [repo, setRepo] = useState<string | null>(initialRepo);
  const [refs, setRefs] = useState<RefList | null>(null);
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState(WORKDIR);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [conflictFile, setConflictFile] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const diffApi = useRef<DiffHandle>(null);

  const loadRepo = useCallback(
    async (path: string) => {
      try {
        const r = await api.gitListRefs(path);
        setRefs(r);
        setRepo(path);
        setConflicts(await api.gitConflicts(path));
      } catch (e) {
        toast(String(e), true);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (initialRepo) loadRepo(initialRepo);
  }, [initialRepo, loadRepo]);

  async function pick() {
    const p = await api.pickFolder();
    if (p) loadRepo(p);
  }

  async function compare() {
    if (!repo) return;
    try {
      const c = await api.gitChangedFiles(repo, from, to);
      setChanges(c);
      setConflictFile(null);
      setFile(c[0]?.path ?? null);
    } catch (e) {
      toast(String(e), true);
    }
  }

  useEffect(() => {
    if (!repo || !file) {
      setLeft("");
      setRight("");
      return;
    }
    let alive = true;
    (async () => {
      const l = (await api.gitFile(repo, from, file)) ?? "";
      const r = (await api.gitFile(repo, to, file)) ?? "";
      // Revert icons apply the `from` version of a block into the working tree.
      const hk = await api.gitFileHunks(repo, from, to, file);
      if (alive) {
        setLeft(l);
        setRight(r);
        setHunks(hk);
      }
    })();
    return () => {
      alive = false;
    };
  }, [repo, file, from, to]);

  async function revertHunk(index: number) {
    if (!repo || !file) return;
    try {
      await api.gitRevertHunks(repo, from, to, file, [index]);
      toast(`Applied ${from} version of a block to working tree`);
      if (to === WORKDIR) setRight((await api.gitFile(repo, to, file)) ?? "");
      setHunks(await api.gitFileHunks(repo, from, to, file));
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function persistWorking(value: string) {
    if (!repo || !file) return;
    try {
      await api.gitWriteWorking(repo, file, value);
      if (to === WORKDIR) setRight(value);
      setHunks(await api.gitFileHunks(repo, from, to, file));
    } catch (e) {
      toast(String(e), true);
    }
  }

  const refOptions = (includeWorkdir: boolean) => (
    <>
      {includeWorkdir && <option value={WORKDIR}>Working tree</option>}
      <option value="HEAD">HEAD</option>
      {refs && refs.branches.length > 0 && (
        <optgroup label="Branches">
          {refs.branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
      )}
      {refs && refs.commits.length > 0 && (
        <optgroup label="Commits">
          {refs.commits.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id.slice(0, 8)} · {c.summary.slice(0, 40)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <>
      <div className="col">
        <div className="git-bar">
          <button className="tbtn primary" onClick={pick}>
            {repo ? "Change repo" : "Open repo…"}
          </button>
          {repo && (
            <span className="repo-name" title={repo}>
              {basename(repo)}
            </span>
          )}
          {repo && (
            <>
              <select className="ref" value={from} onChange={(e) => setFrom(e.target.value)}>
                {refOptions(false)}
              </select>
              <span className="arrow">→</span>
              <select className="ref" value={to} onChange={(e) => setTo(e.target.value)}>
                {refOptions(true)}
              </select>
              <button className="tbtn" onClick={compare}>
                Compare
              </button>
            </>
          )}
        </div>
        {repo && (
          <div className="col-head">
            <h2>Changed Files</h2>
            <span className="changecount">{changes.length}</span>
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="conflict-banner">
            ⚠ {conflicts.length} conflict(s)
          </div>
        )}
        <div className="col-scroll">
          {conflicts.map((p) => (
            <div
              key={p}
              className={`frow${conflictFile === p ? " on" : ""}`}
              onClick={() => {
                setConflictFile(p);
                setFile(null);
              }}
            >
              <span className="stat deleted" style={{ color: "var(--conflict)", background: "var(--conflict-bg)" }}>
                !
              </span>
              <span className="fname">
                <b>{p}</b>
              </span>
            </div>
          ))}
          <ChangedTree
            changes={changes}
            selected={file}
            onSelect={(p) => {
              setFile(p);
              setConflictFile(null);
            }}
          />
        </div>
      </div>

      {conflictFile && repo ? (
        <ConflictResolver
          repoPath={repo}
          path={conflictFile}
          toast={toast}
          onResolved={async () => {
            setConflicts(await api.gitConflicts(repo));
            setConflictFile(null);
          }}
        />
      ) : file ? (
        <div className="col main">
          <div className="diff-head">
            <span className="file" title={file}>
              {file}
            </span>
            <button className="tbtn" title="Previous change" onClick={() => diffApi.current?.navigate("prev")}>
              ↑
            </button>
            <button className="tbtn" title="Next change" onClick={() => diffApi.current?.navigate("next")}>
              ↓
            </button>
            <span className="vs">
              {from} → {to === WORKDIR ? "working tree" : to}
            </span>
            {hunks.length > 0 && (
              <span className="changecount" title={`Click ⟲ in the gutter to apply the ${from} version of a block to the working tree`}>
                {hunks.length} change{hunks.length === 1 ? "" : "s"} · ⟲ applies {from} → working
              </span>
            )}
            <button
              className="tbtn"
              style={{ marginLeft: "auto" }}
              onClick={() => setInline(!inline)}
              title="Diff layout: side-by-side or inline"
            >
              {inline ? "≣ inline" : "⇆ split"}
            </button>
          </div>
          <DiffEditor
            original={left}
            modified={right}
            language={langOf(file)}
            inline={inline}
            editable={to === WORKDIR}
            onCommit={persistWorking}
            hunks={hunks}
            onRevertHunk={revertHunk}
            ref={diffApi}
          />
        </div>
      ) : (
        <div className="col main">
          <div className="empty">
            <div className="glyph">⎇</div>
            <h3>{repo ? "Compare revisions" : "Open a git repository"}</h3>
            <p>
              {repo
                ? "Pick two refs above and hit Compare. Conflicts from an in-progress merge show up on the left."
                : "Choose a local repo to diff branches, commits, the working tree — and resolve merge conflicts."}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

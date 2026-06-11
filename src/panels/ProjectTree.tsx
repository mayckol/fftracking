import { useMemo, useState, useRef, useImperativeHandle, forwardRef, useEffect } from "react";
import { buildFileTree, type TreeNode } from "../lib/filetree";
import { setScopeDir } from "../lib/searchScope";
import { runInTerminal } from "../lib/runner";
import { dirname } from "../lib/util";
import { FileIcon, FolderIcon, GoIcon } from "../components/Icons";

interface Menu {
  x: number;
  y: number;
  kind: "file" | "dir";
  path: string;
}

interface Props {
  files: string[];
  selected: string | null;
  errorFiles?: Set<string>;
  onSelect: (path: string) => void;
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  onIgnoreFile?: (path: string) => void;
  onIgnoreFolder?: (prefix: string) => void;
  onFindInFolder?: (prefix: string) => void;
  onReplaceInFolder?: (prefix: string) => void;
}

export interface ProjectTreeHandle {
  focusInTree: () => void;
}

const ProjectTree = forwardRef<ProjectTreeHandle, Props>(({
  files,
  selected,
  errorFiles,
  onSelect,
  onOpen,
  onReveal,
  onIgnoreFile,
  onIgnoreFolder,
  onFindInFolder,
  onReplaceInFolder,
}: Props, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);

  useImperativeHandle(ref, () => ({
    focusInTree: () => {
      if (selected) {
        pendingFocusRef.current = true;
        const parts = selected.split("/");
        setExpanded((prev) => {
          const next = new Set(prev);
          for (let i = 1; i < parts.length; i++) {
            next.add(parts.slice(0, i).join("/"));
          }
          return next;
        });
      }
    }
  }), [selected]);

  useEffect(() => {
    if (pendingFocusRef.current && selected) {
      pendingFocusRef.current = false;
      const elem = containerRef.current?.querySelector(`[data-path="${selected}"]`) as HTMLElement | null;
      if (elem) {
        elem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [expanded, selected]);

  const tree = useMemo(() => buildFileTree(files.map((path) => ({ path }))), [files]);
  // Folders that contain an error file (every ancestor dir of each error path).
  const errorDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of errorFiles ?? []) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [errorFiles]);

  if (files.length === 0) {
    return (
      <div ref={containerRef} className="empty" style={{ padding: "24px 20px" }}>
        <p>No files tracked in this folder.</p>
      </div>
    );
  }

  const toggle = (path: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const rows: JSX.Element[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      const pad = { paddingLeft: `${8 + depth * 14}px` };
      if (node.kind === "dir") {
        const open = expanded.has(node.path);
        rows.push(
          <div
            key={"d:" + node.path}
            className={`trow dir${errorDirs.has(node.path) ? " err" : ""}`}
            style={pad}
            onClick={() => {
              toggle(node.path);
              // Clicked folder becomes the find/replace scope (⌘⇧F / ⌘⇧R).
              setScopeDir(node.path);
            }}
            onContextMenu={(e) => {
              if (!onReveal && !onIgnoreFolder && !onFindInFolder && !onReplaceInFolder) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "dir", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev">{open ? "▾" : "▸"}</span>
            <FolderIcon open={open} />
            <span className="dname">{node.name}</span>
          </div>,
        );
        if (open) walk(node.children, depth + 1);
      } else {
        rows.push(
          <div
            key={"f:" + node.path}
            data-path={node.path}
            className={`trow file${selected === node.path ? " on" : ""}${errorFiles?.has(node.path) ? " err" : ""}`}
            style={pad}
            onClick={() => {
              setScopeDir(null);
              onSelect(node.path);
            }}
            onContextMenu={(e) => {
              if (!onOpen && !onReveal && !onIgnoreFile) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev" />
            {node.path.endsWith(".go") ? <GoIcon /> : <FileIcon />}
            <span className="tname">{node.name}</span>
          </div>,
        );
      }
    }
  };
  walk(tree, 0);

  return (
    <div ref={containerRef}>
      {rows}
      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.kind === "file" && onOpen && (
              <button onClick={() => { onOpen(menu.path); setMenu(null); }}>Open file</button>
            )}
            {menu.kind === "file" && onReveal && (
              <button onClick={() => { onReveal(menu.path); setMenu(null); }}>Reveal in Finder</button>
            )}
            {menu.kind === "file" && menu.path.endsWith("_test.go") && (
              <button
                onClick={() => {
                  const d = dirname(menu.path).replace(/\/$/, "");
                  runInTerminal(`go test -v ${d ? `./${d}` : "."}`);
                  setMenu(null);
                }}
              >
                ▶ Run go test (package)
              </button>
            )}
            {menu.kind === "file" && onIgnoreFile && (
              <button onClick={() => { onIgnoreFile(menu.path); setMenu(null); }}>
                Ignore history for this file
              </button>
            )}
            {menu.kind === "dir" && (
              <button
                onClick={() => {
                  runInTerminal(`go test -v ./${menu.path}/...`);
                  setMenu(null);
                }}
              >
                ▶ Run go test ./{menu.path}/...
              </button>
            )}
            {menu.kind === "dir" && onFindInFolder && (
              <button onClick={() => { onFindInFolder(menu.path); setMenu(null); }}>Find in folder</button>
            )}
            {menu.kind === "dir" && onReplaceInFolder && (
              <button onClick={() => { onReplaceInFolder(menu.path); setMenu(null); }}>Replace in folder</button>
            )}
            {menu.kind === "dir" && onReveal && (
              <button onClick={() => { onReveal(menu.path); setMenu(null); }}>Reveal in Finder</button>
            )}
            {menu.kind === "dir" && onIgnoreFolder && (
              <button onClick={() => { onIgnoreFolder(menu.path); setMenu(null); }}>
                Ignore history for this path (<code>{menu.path}/**</code>)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
});
ProjectTree.displayName = "ProjectTree";
export default ProjectTree;

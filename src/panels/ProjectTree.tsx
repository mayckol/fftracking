import { useMemo, useState, useRef, useImperativeHandle, forwardRef, useEffect } from "react";
import { buildFileTree, type TreeNode } from "../lib/filetree";
import { setScopeDir } from "../lib/searchScope";
import { startRun } from "../lib/run";
import { dirname } from "../lib/util";
import { FileTypeIcon, FolderTypeIcon } from "../components/FileTypeIcon";
import { CtxShortcut } from "../components/CtxShortcut";

interface Menu {
  x: number;
  y: number;
  kind: "file" | "dir";
  path: string;
}

// Expanded folders survive unmount (switching the sidebar tab to git/plugins/
// settings tears the tree down) — restored per project on remount.
const expandedCache = new Map<string, Set<string>>();

interface Props {
  files: string[];
  selected: string | null;
  errorFiles?: Set<string>;
  /** Files differing from the baseline (git HEAD / latest breaking point) —
   *  tinted green; an LSP error on the same file wins. */
  changedFiles?: Set<string>;
  rootPath?: string | null;
  onSelect: (path: string) => void;
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  onShowHistory?: (path: string, isDir: boolean) => void;
  onCompare?: (path: string, kind: "file" | "dir") => void;
  onCopyPath?: (text: string, label: string) => void;
  onIgnoreFile?: (path: string) => void;
  onIgnoreFolder?: (prefix: string) => void;
  onFindInFolder?: (prefix: string) => void;
  onReplaceInFolder?: (prefix: string) => void;
  onDelete?: (path: string, isDir: boolean) => void;
}

export interface ProjectTreeHandle {
  focusInTree: () => void;
  revealDir: (path: string) => void;
}

const ProjectTree = forwardRef<ProjectTreeHandle, Props>(({
  files,
  selected,
  errorFiles,
  changedFiles,
  rootPath,
  onSelect,
  onOpen,
  onReveal,
  onShowHistory,
  onCompare,
  onCopyPath,
  onIgnoreFile,
  onIgnoreFolder,
  onFindInFolder,
  onReplaceInFolder,
  onDelete,
}: Props, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const cacheKey = rootPath ?? "";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedCache.get(cacheKey)));
  const [hlDir, setHlDir] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    expandedCache.set(cacheKey, expanded);
  }, [cacheKey, expanded]);

  const tree = useMemo(() => buildFileTree(files.map((path) => ({ path }))), [files]);

  useImperativeHandle(ref, () => ({
    focusInTree: () => {
      if (selected) {
        pendingScrollRef.current = selected;
        const parts = selected.split("/");
        setExpanded((prev) => {
          const next = new Set(prev);
          for (let i = 1; i < parts.length; i++) {
            next.add(parts.slice(0, i).join("/"));
          }
          return next;
        });
      }
    },
    revealDir: (path: string) => {
      // Compact folders: the row for `path` may have merged into a deeper
      // single-child chain — fall back to the first row inside it.
      const findRow = (nodes: TreeNode[]): string | null => {
        for (const n of nodes) {
          if (n.kind !== "dir") continue;
          if (n.path === path || n.path.startsWith(`${path}/`)) return n.path;
          const hit = findRow(n.children);
          if (hit) return hit;
        }
        return null;
      };
      const row = findRow(tree);
      if (!row) return;
      const collectNested = (nodes: TreeNode[], into: Set<string>, under: boolean) => {
        for (const n of nodes) {
          if (n.kind !== "dir") continue;
          const inside = under || n.path === row;
          if (inside) into.add(n.path);
          collectNested(n.children, into, inside);
        }
      };
      setHlDir(row);
      pendingScrollRef.current = row;
      setExpanded((prev) => {
        const next = new Set(prev);
        const parts = row.split("/");
        for (let i = 1; i <= parts.length; i++) {
          next.add(parts.slice(0, i).join("/"));
        }
        collectNested(tree, next, false);
        return next;
      });
    },
  }), [selected, tree]);

  useEffect(() => {
    const target = pendingScrollRef.current;
    if (!target) return;
    pendingScrollRef.current = null;
    const elem = containerRef.current?.querySelector(`[data-path="${target}"]`) as HTMLElement | null;
    if (elem) {
      elem.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [expanded]);
  // Folders that contain an error file (every ancestor dir of each error path).
  const errorDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of errorFiles ?? []) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [errorFiles]);
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of changedFiles ?? []) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [changedFiles]);

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

  const absPath = (path: string) =>
    path.startsWith("/") || !rootPath ? path : `${rootPath.replace(/\/$/, "")}/${path}`;

  const copyButtons = (path: string) =>
    onCopyPath && (
      <>
        <button onClick={() => { onCopyPath(absPath(path), "absolute path"); setMenu(null); }}>
          Copy path (absolute)<CtxShortcut id="file.copyPath" />
        </button>
        <button onClick={() => { onCopyPath(path, "relative path"); setMenu(null); }}>
          Copy path (relative)
        </button>
      </>
    );

  const rows: JSX.Element[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      const pad = { paddingLeft: `${8 + depth * 14}px` };
      if (node.kind === "dir") {
        const open = expanded.has(node.path);
        const dErr = errorDirs.has(node.path);
        rows.push(
          <div
            key={"d:" + node.path}
            data-path={node.path}
            className={`trow dir${hlDir === node.path ? " on" : ""}${dErr ? " err" : changedDirs.has(node.path) ? " chg" : ""}`}
            style={pad}
            onClick={() => {
              setHlDir(null);
              toggle(node.path);
              // Clicked folder becomes the find/replace scope (⌘⇧F / ⌘⇧R).
              setScopeDir(node.path);
            }}
            onContextMenu={(e) => {
              if (!onReveal && !onIgnoreFolder && !onFindInFolder && !onReplaceInFolder && !onCopyPath && !onShowHistory && !onDelete) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "dir", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev">{open ? "▾" : "▸"}</span>
            <FolderTypeIcon name={node.name} open={open} />
            <span className="dname">{node.name}</span>
          </div>,
        );
        if (open) walk(node.children, depth + 1);
      } else {
        const fErr = errorFiles?.has(node.path);
        rows.push(
          <div
            key={"f:" + node.path}
            data-path={node.path}
            className={`trow file${selected === node.path ? " on" : ""}${fErr ? " err" : changedFiles?.has(node.path) ? " chg" : ""}`}
            style={pad}
            onClick={() => {
              setHlDir(null);
              setScopeDir(null);
              onSelect(node.path);
            }}
            onContextMenu={(e) => {
              if (!onOpen && !onReveal && !onIgnoreFile && !onCopyPath && !onShowHistory && !onCompare && !onDelete) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev" />
            <FileTypeIcon name={node.name} />
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
              <button onClick={() => { onOpen(menu.path); setMenu(null); }}>Open file<CtxShortcut id="file.open" /></button>
            )}
            {menu.kind === "file" && onShowHistory && (
              <button onClick={() => { onShowHistory(menu.path, false); setMenu(null); }}>Show history for this file</button>
            )}
            {menu.kind === "file" && onCompare && (
              <button onClick={() => { onCompare(menu.path, "file"); setMenu(null); }}>Compare with branch or commit…</button>
            )}
            {menu.kind === "file" && onReveal && (
              <button onClick={() => { onReveal(menu.path); setMenu(null); }}>Reveal in Finder<CtxShortcut id="file.reveal" /></button>
            )}
            {menu.kind === "file" && menu.path.endsWith("_test.go") && rootPath && (
              <button
                onClick={() => {
                  const d = dirname(menu.path).replace(/\/$/, "");
                  const target = d ? `./${d}` : ".";
                  startRun({ cwd: rootPath, label: `go test ${target}`, program: "go", args: ["test", "-v", target] });
                  setMenu(null);
                }}
              >
                ▶ Run go test (package)
              </button>
            )}
            {menu.kind === "file" && copyButtons(menu.path)}
            {menu.kind === "file" && onIgnoreFile && (
              <button onClick={() => { onIgnoreFile(menu.path); setMenu(null); }}>
                Ignore history for this file
              </button>
            )}
            {menu.kind === "file" && onDelete && (
              <button className="danger" onClick={() => { onDelete(menu.path, false); setMenu(null); }}>
                Delete file…
              </button>
            )}
            {menu.kind === "dir" && rootPath && (
              <button
                onClick={() => {
                  const target = `./${menu.path}/...`;
                  startRun({ cwd: rootPath, label: `go test ${target}`, program: "go", args: ["test", "-v", target] });
                  setMenu(null);
                }}
              >
                ▶ Run go test ./{menu.path}/...
              </button>
            )}
            {menu.kind === "dir" && onShowHistory && (
              <button onClick={() => { onShowHistory(menu.path, true); setMenu(null); }}>Show history for this folder</button>
            )}
            {menu.kind === "dir" && onCompare && (
              <button onClick={() => { onCompare(menu.path, "dir"); setMenu(null); }}>Compare with branch or commit…</button>
            )}
            {menu.kind === "dir" && onFindInFolder && (
              <button onClick={() => { onFindInFolder(menu.path); setMenu(null); }}>Find in folder</button>
            )}
            {menu.kind === "dir" && onReplaceInFolder && (
              <button onClick={() => { onReplaceInFolder(menu.path); setMenu(null); }}>Replace in folder</button>
            )}
            {menu.kind === "dir" && onReveal && (
              <button onClick={() => { onReveal(menu.path); setMenu(null); }}>Reveal in Finder<CtxShortcut id="file.reveal" /></button>
            )}
            {menu.kind === "dir" && copyButtons(menu.path)}
            {menu.kind === "dir" && onIgnoreFolder && (
              <button onClick={() => { onIgnoreFolder(menu.path); setMenu(null); }}>
                Ignore history for this path (<code>{menu.path}/**</code>)
              </button>
            )}
            {menu.kind === "dir" && onDelete && (
              <button className="danger" onClick={() => { onDelete(menu.path, true); setMenu(null); }}>
                Delete folder…
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

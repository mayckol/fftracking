import { useMemo, useState } from "react";
import type { FileChange } from "../lib/types";

const GLYPH = { added: "A", modified: "M", deleted: "D" } as const;

interface FileLeaf {
  kind: "file";
  name: string;
  path: string;
  status: FileChange["status"];
}
interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
type TreeNode = FileLeaf | DirNode;

function buildTree(changes: FileChange[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);

  const dirAt = (path: string): DirNode => {
    if (dirs.has(path)) return dirs.get(path)!;
    const slash = path.lastIndexOf("/");
    const parentPath = slash >= 0 ? path.slice(0, slash) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const parent = dirAt(parentPath);
    const node: DirNode = { kind: "dir", name, path, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const c of changes) {
    const slash = c.path.lastIndexOf("/");
    const parent = dirAt(slash >= 0 ? c.path.slice(0, slash) : "");
    parent.children.push({
      kind: "file",
      name: c.path.slice(slash + 1),
      path: c.path,
      status: c.status,
    });
  }

  const cmp = (a: TreeNode, b: TreeNode) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1;

  // Full nesting: each folder level is its own row (dirs first, then files).
  const sortRec = (node: DirNode) => {
    node.children.sort(cmp);
    node.children.forEach((c) => c.kind === "dir" && sortRec(c));
  };
  sortRec(root);
  return root.children;
}

interface Menu {
  x: number;
  y: number;
  kind: "file" | "dir";
  path: string;
}

interface Props {
  changes: FileChange[];
  selected: string | null;
  onSelect: (path: string) => void;
  onRevertFile?: (path: string) => void;
  onRevertFolder?: (prefix: string) => void;
  gitBranch?: string | null;
  onResetFile?: (path: string) => void;
  onResetFolder?: (prefix: string) => void;
}

export default function ChangedTree({
  changes,
  selected,
  onSelect,
  onRevertFile,
  onRevertFolder,
  gitBranch,
  onResetFile,
  onResetFolder,
}: Props) {
  const tree = useMemo(() => buildTree(changes), [changes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);

  if (changes.length === 0) {
    return (
      <div className="empty" style={{ padding: "24px 20px" }}>
        <p>No file changes between this breaking point and {gitBranch ? <b>{gitBranch}</b> : "the one before it"}.</p>
      </div>
    );
  }

  const toggle = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const rows: JSX.Element[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      const pad = { paddingLeft: `${8 + depth * 14}px` };
      if (node.kind === "dir") {
        const open = !collapsed.has(node.path);
        rows.push(
          <div
            key={"d:" + node.path}
            className="trow dir"
            style={pad}
            onClick={() => toggle(node.path)}
            onContextMenu={(e) => {
              if (!onRevertFolder && !onResetFolder) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "dir", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev">{open ? "▾" : "▸"}</span>
            <span className="dname">{node.name}</span>
          </div>,
        );
        if (open) walk(node.children, depth + 1);
      } else {
        rows.push(
          <div
            key={"f:" + node.path}
            className={`trow file${selected === node.path ? " on" : ""}`}
            style={pad}
            onClick={() => onSelect(node.path)}
            onContextMenu={(e) => {
              if (!onRevertFile && !onResetFile) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
            }}
            title={node.path}
          >
            <span className={`stat ${node.status}`}>{GLYPH[node.status]}</span>
            <span className="tname">{node.name}</span>
          </div>,
        );
      }
    }
  };
  walk(tree, 0);

  return (
    <>
      {rows}
      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.kind === "file" && onResetFile && (
              <button onClick={() => { onResetFile(menu.path); setMenu(null); }}>
                Reset this file to {gitBranch ?? "branch"}
              </button>
            )}
            {menu.kind === "file" && onRevertFile && (
              <button onClick={() => { onRevertFile(menu.path); setMenu(null); }}>Revert this file to point</button>
            )}
            {menu.kind === "dir" && onResetFolder && (
              <button onClick={() => { onResetFolder(menu.path); setMenu(null); }}>
                Reset this folder to {gitBranch ?? "branch"}
              </button>
            )}
            {menu.kind === "dir" && onRevertFolder && (
              <button onClick={() => { onRevertFolder(menu.path); setMenu(null); }}>Revert this folder to point</button>
            )}
          </div>
        </>
      )}
    </>
  );
}

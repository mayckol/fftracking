import { useMemo, useState } from "react";
import type { FileChange } from "../lib/types";
import { buildFileTree, type TreeNode } from "../lib/filetree";
import { FolderTypeIcon } from "../components/FileTypeIcon";

const GLYPH = { added: "A", modified: "M", deleted: "D" } as const;

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
  onIgnoreFile?: (path: string) => void;
  onIgnoreFolder?: (prefix: string) => void;
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
  onIgnoreFile,
  onIgnoreFolder,
}: Props) {
  const tree = useMemo(() => buildFileTree(changes), [changes]);
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
              if (!onRevertFolder && !onResetFolder && !onIgnoreFolder) return;
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
        rows.push(
          <div
            key={"f:" + node.path}
            className={`trow file${selected === node.path ? " on" : ""}`}
            style={pad}
            onClick={() => onSelect(node.path)}
            onContextMenu={(e) => {
              if (!onRevertFile && !onResetFile && !onIgnoreFile) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
            }}
            title={node.path}
          >
            <span className={`stat ${node.status}`}>{node.status ? GLYPH[node.status] : ""}</span>
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
            {menu.kind === "file" && onIgnoreFile && (
              <button onClick={() => { onIgnoreFile(menu.path); setMenu(null); }}>Ignore this file</button>
            )}
            {menu.kind === "dir" && onResetFolder && (
              <button onClick={() => { onResetFolder(menu.path); setMenu(null); }}>
                Reset this folder to {gitBranch ?? "branch"}
              </button>
            )}
            {menu.kind === "dir" && onRevertFolder && (
              <button onClick={() => { onRevertFolder(menu.path); setMenu(null); }}>Revert this folder to point</button>
            )}
            {menu.kind === "dir" && onIgnoreFolder && (
              <button onClick={() => { onIgnoreFolder(menu.path); setMenu(null); }}>
                Ignore this folder (<code>{menu.path}/**</code>)
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

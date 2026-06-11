import { useMemo, useState } from "react";
import { buildFileTree, type TreeNode } from "../lib/filetree";
import { FileIcon, FolderIcon } from "../components/Icons";

interface Menu {
  x: number;
  y: number;
  kind: "file" | "dir";
  path: string;
}

interface Props {
  files: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  onIgnoreFile?: (path: string) => void;
  onIgnoreFolder?: (prefix: string) => void;
}

export default function ProjectTree({ files, selected, onSelect, onOpen, onReveal, onIgnoreFile, onIgnoreFolder }: Props) {
  const tree = useMemo(() => buildFileTree(files.map((path) => ({ path }))), [files]);
  // Default collapsed: only paths in this set are open.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);

  if (files.length === 0) {
    return (
      <div className="empty" style={{ padding: "24px 20px" }}>
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
            className="trow dir"
            style={pad}
            onClick={() => toggle(node.path)}
            onContextMenu={(e) => {
              if (!onIgnoreFolder) return;
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
            className={`trow file${selected === node.path ? " on" : ""}`}
            style={pad}
            onClick={() => onSelect(node.path)}
            onContextMenu={(e) => {
              if (!onOpen && !onReveal && !onIgnoreFile) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
            }}
            title={node.path}
          >
            <span className="chev" />
            <FileIcon />
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
            {menu.kind === "file" && onOpen && (
              <button onClick={() => { onOpen(menu.path); setMenu(null); }}>Open file</button>
            )}
            {menu.kind === "file" && onReveal && (
              <button onClick={() => { onReveal(menu.path); setMenu(null); }}>Reveal in Finder</button>
            )}
            {menu.kind === "file" && onIgnoreFile && (
              <button onClick={() => { onIgnoreFile(menu.path); setMenu(null); }}>Ignore this file</button>
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { GitFileChange } from "../lib/types";
import { buildFileTree, type TreeNode } from "../lib/filetree";
import { FolderTypeIcon } from "../components/FileTypeIcon";

const GLYPH = { added: "A", modified: "M", deleted: "D" } as const;

interface Props {
  changes: GitFileChange[];
  staged: boolean;
  selected: string | null;
  onSelect: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onContextMenu: (ctx: { paths: string[]; isDir: boolean; label: string; x: number; y: number }) => void;
}

function filesUnder(node: TreeNode): string[] {
  return node.kind === "file" ? [node.path] : node.children.flatMap(filesUnder);
}

export default function CommitTree({
  changes,
  staged,
  selected,
  onSelect,
  onOpenFile,
  onStage,
  onUnstage,
  onContextMenu,
}: Props) {
  const tree = useMemo(() => buildFileTree(changes), [changes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selRow = useRef<HTMLDivElement | null>(null);

  // Keyboard ↑/↓ nav moves the selection across files; reveal the row so it
  // tracks even when the diff spilled into an off-screen file.
  useEffect(() => {
    selRow.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const toggle = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const apply = staged ? onUnstage : onStage;
  const glyph = staged ? "−" : "+";
  const verb = staged ? "Unstage" : "Stage";

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
              e.preventDefault();
              onContextMenu({ paths: filesUnder(node), isDir: true, label: node.name, x: e.clientX, y: e.clientY });
            }}
            title={node.path}
          >
            <span className="chev">{open ? "▾" : "▸"}</span>
            <FolderTypeIcon name={node.name} open={open} />
            <span className="dname">{node.name}</span>
            <button
              className="stage-btn"
              title={`${verb} all in ${node.name}/`}
              onClick={(e) => {
                e.stopPropagation();
                apply(filesUnder(node));
              }}
            >
              {glyph}
            </button>
          </div>,
        );
        if (open) walk(node.children, depth + 1);
      } else {
        rows.push(
          <div
            key={"f:" + node.path}
            ref={selected === node.path ? selRow : undefined}
            className={`trow file${selected === node.path ? " on" : ""}`}
            style={pad}
            onClick={() => onSelect(node.path)}
            onDoubleClick={() => onOpenFile?.(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu({ paths: [node.path], isDir: false, label: node.name, x: e.clientX, y: e.clientY });
            }}
            title={node.path}
          >
            <span className={`stat ${node.status}`}>{node.status ? GLYPH[node.status] : ""}</span>
            <span className="tname">{node.name}</span>
            <button
              className="stage-btn"
              title={verb}
              onClick={(e) => {
                e.stopPropagation();
                apply([node.path]);
              }}
            >
              {glyph}
            </button>
          </div>,
        );
      }
    }
  };
  walk(tree, 0);

  return <>{rows}</>;
}

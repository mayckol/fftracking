import type { FileChange } from "./types";

export interface FileLeaf {
  kind: "file";
  name: string;
  path: string;
  status?: FileChange["status"];
}
export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
export type TreeNode = FileLeaf | DirNode;

export interface TreeInput {
  path: string;
  status?: FileChange["status"];
}

const cmp = (a: TreeNode, b: TreeNode) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1;

// VSCode-style "compact folders": a directory whose only child is another
// directory collapses into a single row (e.g. pkg/database/generated), so long
// single-occupancy chains don't waste vertical space.
function compact(node: DirNode) {
  node.children.forEach((c) => c.kind === "dir" && compact(c));
  while (node.children.length === 1 && node.children[0].kind === "dir") {
    const only = node.children[0];
    node.name = `${node.name}/${only.name}`;
    node.path = only.path;
    node.children = only.children;
  }
}

export function buildFileTree(items: TreeInput[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);

  const dirAt = (path: string): DirNode => {
    if (dirs.has(path)) return dirs.get(path)!;
    const slash = path.lastIndexOf("/");
    const parent = dirAt(slash >= 0 ? path.slice(0, slash) : "");
    const node: DirNode = { kind: "dir", name: slash >= 0 ? path.slice(slash + 1) : path, path, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const it of items) {
    const slash = it.path.lastIndexOf("/");
    dirAt(slash >= 0 ? it.path.slice(0, slash) : "").children.push({
      kind: "file",
      name: it.path.slice(slash + 1),
      path: it.path,
      status: it.status,
    });
  }

  const sortRec = (node: DirNode) => {
    node.children.sort(cmp);
    node.children.forEach((c) => c.kind === "dir" && sortRec(c));
  };
  sortRec(root);
  root.children.forEach((c) => c.kind === "dir" && compact(c));
  return root.children;
}

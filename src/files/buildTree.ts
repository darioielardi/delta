// src/files/buildTree.ts
import type { FileEntry } from "../types";

export interface TreeNode {
  id: string; // = path; stable node identifier
  name: string;
  path: string;
  kind: "dir" | "file";
  entry?: FileEntry;
  children: TreeNode[];
}

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { id: "", name: "", path: "", kind: "dir", children: [] };
  // Index every node by its full path so each level is an O(1) lookup instead of
  // a linear children.find() — that was O(files × depth × siblings) on big trees.
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const entry of files) {
    const parts = entry.path.split("/");
    let parentPath = "";
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = byPath.get(path);
      if (!child) {
        child = { id: path, name: part, path, kind: isFile ? "file" : "dir", children: [], entry: isFile ? entry : undefined };
        byPath.get(parentPath)!.children.push(child);
        byPath.set(path, child);
      }
      parentPath = path;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

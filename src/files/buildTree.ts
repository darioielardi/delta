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
  for (const entry of files) {
    const parts = entry.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { id: path, name: part, path, kind: isFile ? "file" : "dir", children: [], entry: isFile ? entry : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

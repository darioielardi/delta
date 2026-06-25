// src/files/FilesPanel.tsx
import { useLayoutEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FileEntry, FileStatus } from "../types";
import { buildTree, type TreeNode } from "./buildTree";

const STATUS_LETTER: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-emerald-600", modified: "text-amber-600", deleted: "text-red-600", renamed: "text-blue-600",
};

// react-arborist needs explicit pixel dimensions; measure the container.
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

export function FilesPanel({ files, selected, onSelect, viewedFiles, onToggleViewed }: { files: FileEntry[]; selected: string | null; onSelect: (path: string) => void; viewedFiles: Set<string>; onToggleViewed: (file: string) => void }) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const { ref, width, height } = useSize();

  // FileNode closes over viewedFiles/onToggleViewed so it can render the viewed checkbox.
  function FileNode({ node, style }: NodeRendererProps<TreeNode>) {
    const data = node.data;
    const isDir = data.kind === "dir";
    const isViewed = !isDir && data.entry ? viewedFiles.has(data.entry.path) : false;
    return (
      <div
        style={style}
        className={`flex items-center gap-2 px-2 text-xs cursor-pointer rounded-sm ${node.isSelected ? "bg-accent" : "hover:bg-muted"} ${isViewed ? "opacity-50" : ""}`}
        onClick={() => (isDir ? node.toggle() : node.select())}
      >
        {isDir ? (
          node.isOpen ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
        ) : (
          <span className={`w-3.5 text-center font-semibold ${STATUS_COLOR[data.entry!.status]}`}>
            {STATUS_LETTER[data.entry!.status]}
          </span>
        )}
        <span className="truncate flex-1">{data.name}{isDir ? "/" : ""}</span>
        {!isDir && data.entry && (
          <>
            <span className="shrink-0 tabular-nums">
              {data.entry.additions > 0 && <span className="text-emerald-600">+{data.entry.additions}</span>}{" "}
              {data.entry.deletions > 0 && <span className="text-red-600">−{data.entry.deletions}</span>}
            </span>
            <input
              type="checkbox"
              checked={isViewed}
              onChange={() => onToggleViewed(data.entry!.path)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`viewed ${data.entry.path}`}
              className="shrink-0"
            />
          </>
        )}
      </div>
    );
  }

  if (files.length === 0) return <div className="files-empty p-6 text-muted-foreground text-sm">Nothing to review</div>;

  // tree mode = nested; list mode = flat leaves (react-arborist renders both shapes).
  const data: TreeNode[] =
    mode === "tree"
      ? buildTree(files)
      : files.map((e) => ({ id: e.path, name: e.path, path: e.path, kind: "file", entry: e, children: [] }));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground border-b">
        <span>{files.length} files</span>
        <span className="ml-auto">{viewedFiles.size}/{files.length} viewed</span>
        <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as "tree" | "list")}>
          <ToggleGroupItem value="list">List</ToggleGroupItem>
          <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div ref={ref} data-testid="files-tree" className="flex-1 min-h-0">
        {width > 0 && (
          <Tree<TreeNode>
            data={data}
            openByDefault
            width={width}
            height={height}
            rowHeight={24}
            indent={12}
            selection={selected ?? undefined}
            onSelect={(nodes) => {
              const n = nodes[0];
              if (n && n.data.kind === "file") onSelect(n.data.path);
            }}
          >
            {FileNode}
          </Tree>
        )}
      </div>
    </div>
  );
}

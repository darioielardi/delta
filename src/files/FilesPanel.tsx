// src/files/FilesPanel.tsx
import { useLayoutEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FileEntry, FileStatus } from "../types";
import { buildTree, type TreeNode } from "./buildTree";

const STATUS_LETTER: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-emerald-500", modified: "text-amber-500", deleted: "text-rose-500", renamed: "text-sky-500",
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
        className={`flex h-full cursor-pointer items-center gap-2 rounded-md px-2 transition-colors ${node.isSelected ? "bg-accent" : "hover:bg-foreground/[0.05]"} ${isViewed ? "opacity-45" : ""}`}
        onClick={() => (isDir ? node.toggle() : node.select())}
      >
        {isDir ? (
          node.isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className={`w-3.5 shrink-0 text-center text-[11px] font-bold ${STATUS_COLOR[data.entry!.status]}`}>
            {STATUS_LETTER[data.entry!.status]}
          </span>
        )}
        <span className={`flex-1 truncate text-[13px] ${isDir ? "font-medium text-muted-foreground" : "text-foreground"}`}>
          {data.name}{isDir ? "/" : ""}
        </span>
        {!isDir && data.entry && (
          <>
            <span className="shrink-0 text-[11px] tabular-nums">
              {data.entry.additions > 0 && <span className="text-emerald-500">+{data.entry.additions}</span>}{" "}
              {data.entry.deletions > 0 && <span className="text-rose-500">−{data.entry.deletions}</span>}
            </span>
            <input
              type="checkbox"
              checked={isViewed}
              onChange={() => onToggleViewed(data.entry!.path)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`viewed ${data.entry.path}`}
              className="size-3.5 shrink-0 accent-[var(--primary)]"
            />
          </>
        )}
      </div>
    );
  }

  if (files.length === 0) return <div className="files-empty flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">Nothing to review</div>;

  // tree mode = nested; list mode = flat leaves (react-arborist renders both shapes).
  const data: TreeNode[] =
    mode === "tree"
      ? buildTree(files)
      : files.map((e) => ({ id: e.path, name: e.path, path: e.path, kind: "file", entry: e, children: [] }));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]">
        <span className="font-medium text-foreground">{files.length} files</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-muted-foreground">{viewedFiles.size}/{files.length} viewed</span>
        <ToggleGroup
          type="single"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as "tree" | "list")}
          className="ml-auto gap-0.5 rounded-md bg-muted/70 p-0.5"
        >
          <ToggleGroupItem value="list" className="h-5 rounded-[5px] border-0 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">List</ToggleGroupItem>
          <ToggleGroupItem value="tree" className="h-5 rounded-[5px] border-0 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">Tree</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div ref={ref} data-testid="files-tree" className="min-h-0 flex-1 px-1.5 py-1.5">
        {width > 0 && (
          <Tree<TreeNode>
            data={data}
            openByDefault
            width={width}
            height={height}
            rowHeight={30}
            indent={14}
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

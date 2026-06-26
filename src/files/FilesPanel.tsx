// src/files/FilesPanel.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronRight, Folder, FolderOpen, FileCode, FileJson, FileText, Check, List, ListTree } from "lucide-react";
import type { FileEntry, FileStatus } from "../types";
import { buildTree, type TreeNode } from "./buildTree";

const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-emerald-500",
  modified: "text-amber-500",
  deleted: "text-rose-500",
  renamed: "text-sky-500",
};

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "rb", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp", "css", "scss", "html", "vue", "svelte", "sh", "toml", "yml", "yaml",
]);

function FileGlyph({ name, status }: { name: string; status: FileStatus }) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const Icon = ext === "json" ? FileJson : CODE_EXT.has(ext) ? FileCode : FileText;
  // Icon colored by git status — one glyph carries both file type and change kind.
  return <Icon className={`size-3.5 shrink-0 ${STATUS_COLOR[status]}`} />;
}

interface RowHandlers {
  activePath: string | null;
  collapsed: Set<string>;
  viewedFiles: Set<string>;
  flat: boolean;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleViewed: (file: string) => void;
}

function TreeRows({ nodes, h }: { nodes: TreeNode[]; h: RowHandlers }) {
  return (
    <>
      {nodes.map((node) => (
        <TreeBranch key={node.path} node={node} h={h} />
      ))}
    </>
  );
}

function TreeBranch({ node, h }: { node: TreeNode; h: RowHandlers }) {
  const isDir = node.kind === "dir";
  const open = isDir && !h.collapsed.has(node.path);
  const active = node.path === h.activePath;
  const isViewed = !isDir && node.entry ? h.viewedFiles.has(node.entry.path) : false;

  return (
    <div>
      <div
        data-path={node.path}
        className={`group flex h-6 select-none items-center gap-1.5 rounded-md pl-1 pr-1.5 ${active ? "bg-accent" : "hover:bg-foreground/[0.05]"} ${isViewed ? "opacity-50" : ""}`}
        onClick={() => (isDir ? h.onToggleDir(node.path) : h.onSelectFile(node.path))}
      >
        {isDir ? (
          <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        ) : h.flat ? null : (
          <span data-testid="tree-indent" className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          open
            ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            : <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileGlyph name={node.name} status={node.entry!.status} />
        )}
        <span className={`flex-1 truncate text-[13px] ${isDir ? "font-medium text-foreground" : "text-foreground"}`}>
          {node.name}
        </span>
        {!isDir && node.entry && (
          <>
            <span className="shrink-0 text-[11px] tabular-nums">
              {node.entry.additions > 0 && <span className="text-emerald-500">+{node.entry.additions}</span>}{" "}
              {node.entry.deletions > 0 && <span className="text-rose-500">−{node.entry.deletions}</span>}
            </span>
            <button
              aria-label={`viewed ${node.entry.path}`}
              onClick={(e) => { e.stopPropagation(); h.onToggleViewed(node.entry!.path); }}
              className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${isViewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80 group-hover:border-foreground/40 hover:!border-foreground/60"}`}
            >
              {isViewed && <Check className="size-2.5" strokeWidth={3} />}
            </button>
          </>
        )}
      </div>
      {/* Render children only when open: collapsed subtrees unmount entirely,
          so a toggle no longer reflows hundreds of clipped-but-mounted rows. */}
      {isDir && open && (
        <div className="ml-2.5 border-l border-border/40 pl-0">
          <TreeRows nodes={node.children} h={h} />
        </div>
      )}
    </div>
  );
}

export function FilesPanel({
  files, selected, onSelect, viewedFiles, onToggleViewed,
}: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  viewedFiles: Set<string>;
  onToggleViewed: (file: string) => void;
}) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(selected);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-focused row scrolled into view.
  useEffect(() => {
    if (!activePath) return;
    const el = scrollRef.current?.querySelector(`[data-path="${activePath}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [activePath]);

  const roots: TreeNode[] = useMemo(
    () => mode === "tree"
      ? buildTree(files)
      : files.map((e) => ({ id: e.path, name: e.path, path: e.path, kind: "file" as const, entry: e, children: [] })),
    [files, mode],
  );

  // Flatten the currently-visible rows (respecting collapse) for keyboard nav.
  const visible: TreeNode[] = useMemo(() => {
    const out: TreeNode[] = [];
    (function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        out.push(n);
        if (n.kind === "dir" && !collapsed.has(n.path)) walk(n.children);
      }
    })(roots);
    return out;
  }, [roots, collapsed]);

  // Cheap sums — React Compiler memoizes the render; no manual useMemo needed.
  const totalAdds = files.reduce((n, f) => n + f.additions, 0);
  const totalDels = files.reduce((n, f) => n + f.deletions, 0);

  // All hooks must run unconditionally — keep the empty-state return below them.
  if (files.length === 0) {
    return <div className="files-empty flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">Nothing to review</div>;
  }

  const toggleDir = (path: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const selectFile = (path: string) => { setActivePath(path); onSelect(path); };

  function onKeyDown(e: React.KeyboardEvent) {
    if (!visible.length) return;
    const idx = visible.findIndex((n) => n.path === activePath);
    const cur = idx >= 0 ? visible[idx] : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActivePath(visible[Math.min(idx + 1, visible.length - 1)]?.path ?? visible[0].path);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActivePath(visible[Math.max((idx < 0 ? 0 : idx) - 1, 0)]?.path ?? visible[0].path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur?.kind === "dir" && collapsed.has(cur.path)) toggleDir(cur.path);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur?.kind === "dir" && !collapsed.has(cur.path)) toggleDir(cur.path);
        break;
      case "Enter":
        e.preventDefault();
        if (cur?.kind === "file") selectFile(cur.path);
        else if (cur?.kind === "dir") toggleDir(cur.path);
        break;
    }
  }

  const h: RowHandlers = { activePath, collapsed, viewedFiles, flat: mode === "list", onToggleDir: toggleDir, onSelectFile: selectFile, onToggleViewed };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]">
        <span className="text-muted-foreground">{viewedFiles.size}/{files.length} viewed</span>
        <span className="ml-auto tabular-nums">
          {totalAdds > 0 && <span className="text-emerald-500">+{totalAdds}</span>}{" "}
          {totalDels > 0 && <span className="text-rose-500">−{totalDels}</span>}
        </span>
        <ToggleGroup
          type="single"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as "tree" | "list")}
          className="gap-0.5 rounded-md bg-muted/70 p-0.5"
        >
          <ToggleGroupItem value="list" aria-label="List" title="List" className="size-5 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"><List className="size-3.5" /></ToggleGroupItem>
          <ToggleGroupItem value="tree" aria-label="Tree" title="Tree" className="size-5 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"><ListTree className="size-3.5" /></ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div
        ref={scrollRef}
        data-testid="files-tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5 outline-none"
      >
        <TreeRows nodes={roots} h={h} />
      </div>
    </div>
  );
}

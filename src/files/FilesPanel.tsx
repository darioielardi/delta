// src/files/FilesPanel.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder, FolderOpen, FileCode, FileJson, FileText, Check, List, ListTree, Search, X } from "lucide-react";
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

// Stable empty set so search-mode (force-open) rendering doesn't allocate per render.
const NO_COLLAPSE: Set<string> = new Set();

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
        className={`group flex h-[26px] select-none items-center gap-1.5 rounded-md ${h.flat ? "pl-2.5" : "pl-1"} pr-1.5 ${active ? "bg-accent" : "hover:bg-foreground/[0.05]"} ${isViewed ? "opacity-65" : ""}`}
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
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Keep the active row in view, but never flush against the top/bottom edge:
  // leave ~one row of padding so a neighbor is always visible (unless the row is
  // truly first/last, where the scroll clamps). (#r3)
  useEffect(() => {
    if (!activePath) return;
    const container = scrollRef.current;
    const el = container?.querySelector(`[data-path="${activePath}"]`) as HTMLElement | null;
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const rowTop = eRect.top - cRect.top + container.scrollTop;
    const pad = eRect.height + 6; // one neighbor row of breathing room
    if (rowTop - pad < container.scrollTop) {
      container.scrollTop = Math.max(0, rowTop - pad);
    } else if (rowTop + eRect.height + pad > container.scrollTop + container.clientHeight) {
      container.scrollTop = rowTop + eRect.height + pad - container.clientHeight;
    }
  }, [activePath]);

  // Follow the diff viewport (scroll-spy): when the top file changes, select it
  // so the highlight tracks what you're looking at. Keyboard/click selection
  // still wins until the diff scrolls again (which is when `selected` changes). (#r3)
  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    if (selected) setActivePath(selected);
  }, [selected]);

  // ⌘F focuses the file search (Escape on the input clears, then blurs). (#3)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "f" || e.key === "F") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const filteredFiles = useMemo(
    () => (searching ? files.filter((f) => f.path.toLowerCase().includes(q)) : files),
    [files, q, searching],
  );

  const roots: TreeNode[] = useMemo(
    () => mode === "tree"
      ? buildTree(filteredFiles)
      : filteredFiles.map((e) => ({ id: e.path, name: e.path, path: e.path, kind: "file" as const, entry: e, children: [] })),
    [filteredFiles, mode],
  );

  // Flatten the currently-visible rows for keyboard nav. While searching, every
  // dir is force-open so matches are never hidden behind a collapsed parent.
  const visible: TreeNode[] = useMemo(() => {
    const out: TreeNode[] = [];
    (function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        out.push(n);
        if (n.kind === "dir" && (searching || !collapsed.has(n.path))) walk(n.children);
      }
    })(roots);
    return out;
  }, [roots, collapsed, searching]);

  // Every directory path, for collapse/expand-all. `roots` is the full tree when
  // not searching, and the collapse-all button is hidden while searching, so this
  // stays accurate without rebuilding the tree.
  const treeDirPaths = useMemo(() => {
    if (mode !== "tree") return [] as string[];
    const out: string[] = [];
    (function walk(nodes: TreeNode[]) {
      for (const n of nodes) if (n.kind === "dir") { out.push(n.path); walk(n.children); }
    })(roots);
    return out;
  }, [roots, mode]);
  const anyDirOpen = treeDirPaths.some((p) => !collapsed.has(p));

  // Cheap sums — React Compiler memoizes the render; no manual useMemo needed.
  const totalAdds = files.reduce((n, f) => n + f.additions, 0);
  const totalDels = files.reduce((n, f) => n + f.deletions, 0);
  const allViewed = files.length > 0 && viewedFiles.size >= files.length;

  // All hooks must run unconditionally — keep the empty-state return below them.
  if (files.length === 0) {
    return <div className="files-empty flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">Nothing to review</div>;
  }

  const toggleDir = (path: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const toggleAll = () => setCollapsed(anyDirOpen ? new Set(treeDirPaths) : new Set());
  const selectFile = (path: string) => { setActivePath(path); onSelect(path); };

  function onKeyDown(e: React.KeyboardEvent) {
    if (!visible.length) return;
    const idx = visible.findIndex((n) => n.path === activePath);
    const cur = idx >= 0 ? visible[idx] : undefined;
    // Arrows loop and jump-scroll the diff to the file; Enter toggles viewed;
    // left/right collapse/expand dirs. (#r5)
    const moveTo = (n: TreeNode) => (n.kind === "file" ? selectFile(n.path) : setActivePath(n.path));
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(visible[idx < 0 ? 0 : (idx + 1) % visible.length]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(visible[idx <= 0 ? visible.length - 1 : idx - 1]);
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
        if (cur?.kind === "file") onToggleViewed(cur.path);
        else if (cur?.kind === "dir") toggleDir(cur.path);
        break;
    }
  }

  // Search-box keys: Escape clears (then blurs), Enter opens the first match,
  // ArrowDown drops focus into the tree at the first row.
  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (query) setQuery("");
      else searchRef.current?.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = visible.find((n) => n.kind === "file");
      if (first) selectFile(first.path);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = visible[0];
      if (first) { setActivePath(first.path); scrollRef.current?.focus(); }
    }
  }

  const h: RowHandlers = {
    activePath,
    collapsed: searching ? NO_COLLAPSE : collapsed,
    viewedFiles,
    flat: mode === "list",
    onToggleDir: toggleDir,
    onSelectFile: selectFile,
    onToggleViewed,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]">
        <span
          className={`inline-block select-none rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${allViewed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
          title="Files viewed"
        >
          <span className={`font-medium ${allViewed ? "" : "text-foreground"}`}>{viewedFiles.size}</span>
          <span className="opacity-80">{" / "}{files.length} viewed</span>
        </span>
        <span className="ml-auto tabular-nums">
          {totalAdds > 0 && <span className="text-emerald-500">+{totalAdds}</span>}{" "}
          {totalDels > 0 && <span className="text-rose-500">−{totalDels}</span>}
        </span>
        <div className="flex items-center gap-1">
          {mode === "tree" && !searching && (
            <button
              type="button"
              onClick={toggleAll}
              aria-label={anyDirOpen ? "Collapse all" : "Expand all"}
              title={anyDirOpen ? "Collapse all" : "Expand all"}
              className="flex size-5 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              {anyDirOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
            </button>
          )}
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
      </div>

      {/* Search sits directly on top of the tree/list; ⌘F focuses it. (#3) */}
      <div className="relative shrink-0 border-b border-border/70 px-2 py-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search files…"
          aria-label="Search files"
          className="h-7 w-full rounded-md border border-input bg-muted/40 pl-8 pr-12 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:bg-muted focus:bg-background"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => { setQuery(""); searchRef.current?.focus(); }}
            aria-label="Clear search"
            title="Clear"
            className="absolute right-3.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3" strokeWidth={2.5} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 rounded border border-border/70 bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">⌘F</kbd>
        )}
      </div>

      <div
        ref={scrollRef}
        data-testid="files-tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5 outline-none"
      >
        {searching && roots.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">No files match “{query}”.</div>
        ) : (
          <TreeRows nodes={roots} h={h} />
        )}
      </div>
    </div>
  );
}

// src/files/FilesPanel.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder, FolderOpen, FileCode, FileJson, FileText, Check, List, ListTree, MessageSquare, Search, X } from "lucide-react";
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
// Stable empty map fallback when no comment counts are supplied. (#1)
const EMPTY_COUNTS: Map<string, number> = new Map();

// Compact large diff totals so the header stays on one line: over 100k → drop the
// last three digits and append "k" (156048 → "156k"). Smaller counts stay exact.
const fmtCount = (n: number) => (n > 100_000 ? `${Math.floor(n / 1000)}k` : String(n));

// Row windowing geometry (#virtual). Rows are a fixed height, so a row's y-offset is
// exact arithmetic — we mount only the on-screen slice of a flattened node list and
// float it over a full-height spacer. Same idea as VirtualDiffPane, but simpler
// (uniform rows). INDENT/ROW_PL reproduce the old nested ml-2.5 / pl-1 indentation
// now that rows render flat instead of via nested wrappers.
const ROW_H = 26;         // must match the row's h-[26px]
const INDENT = 10;        // px per tree depth (old ml-2.5 = 0.625rem)
const ROW_PL = 4;         // base row padding-left in tree mode (old pl-1 = 0.25rem)
const FLAT_PL = 10;       // list-mode padding-left (old pl-2.5 = 0.625rem)
const TREE_PAD_Y = 6;     // top/bottom breathing room in the scroller (old py-1.5)
const OVERSCAN_ROWS = 16; // rows rendered beyond the viewport each way

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
  commentCounts: Map<string, number>;
  flat: boolean;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleViewed: (file: string) => void;
  // Pointer rested on / left a file row — drives hover-prefetch of its diff.
  onHoverFile: (path: string | null) => void;
}

// One flattened tree row, absolutely positioned at `top` inside the spacer. Depth
// drives indentation and the vertical guide lines that used to come from nested
// border-l wrappers — collapsed subtrees simply never appear in `visible`. (#virtual)
function Row({ node, depth, top, h }: { node: TreeNode; depth: number; top: number; h: RowHandlers }) {
  const isDir = node.kind === "dir";
  const open = isDir && !h.collapsed.has(node.path);
  const active = node.path === h.activePath;
  const isViewed = !isDir && node.entry ? h.viewedFiles.has(node.entry.path) : false;
  const commentN = !isDir && node.entry ? h.commentCounts.get(node.entry.path) ?? 0 : 0;
  const paddingLeft = h.flat ? FLAT_PL : depth * INDENT + ROW_PL;
  // Renamed file → tooltip names the source path (the sky icon already flags the
  // rename; the old path isn't shown inline to keep the narrow rows uncluttered).
  const renamedFrom = !isDir && node.entry?.status === "renamed" && node.entry.oldPath ? node.entry.oldPath : null;

  return (
    <div
      data-path={node.path}
      title={renamedFrom ? `Renamed from ${renamedFrom}` : undefined}
      className={`group absolute inset-x-0 flex h-[26px] select-none items-center gap-1.5 rounded-md pr-1.5 ${active ? "bg-accent" : "hover:bg-foreground/[0.05]"} ${isViewed ? "opacity-65" : ""}`}
      style={{ top, paddingLeft }}
      onClick={() => (isDir ? h.onToggleDir(node.path) : h.onSelectFile(node.path))}
      onMouseEnter={isDir ? undefined : () => h.onHoverFile(node.path)}
      onMouseLeave={isDir ? undefined : () => h.onHoverFile(null)}
    >
      {/* One vertical guide per ancestor level, replacing the old nested border-l
          wrappers. Positioned from the row's left edge, so stacked rows line up into
          continuous rules at the same x the nested version drew them. (#virtual) */}
      {!h.flat && depth > 0 && Array.from({ length: depth }, (_, k) => (
        <span
          key={k}
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 border-l border-border/40"
          style={{ left: (k + 1) * INDENT }}
        />
      ))}
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
          {commentN > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"
              title={`${commentN} comment${commentN === 1 ? "" : "s"}`}
            >
              <MessageSquare className="size-3" />
              {commentN}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums">
            {node.entry.additions > 0 && <span className="text-emerald-500">+{node.entry.additions}</span>}{" "}
            {node.entry.deletions > 0 && <span className="text-rose-500">−{node.entry.deletions}</span>}
          </span>
          <button
            aria-label={`viewed ${node.entry.path}`}
            onClick={(e) => { e.stopPropagation(); h.onToggleViewed(node.entry!.path); }}
            className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${isViewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80 bg-card dark:bg-transparent group-hover:border-foreground/40 hover:!border-foreground/60"}`}
          >
            {isViewed && <Check className="size-2.5" strokeWidth={3} />}
          </button>
        </>
      )}
    </div>
  );
}

export function FilesPanel({
  files, selected, onSelect, onPrefetch, viewedFiles, onToggleViewed, commentCounts,
}: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  // Build a file's diff ahead of a click (pointer hover). Optional. (#perf)
  onPrefetch?: (path: string) => void;
  viewedFiles: Set<string>;
  onToggleViewed: (file: string) => void;
  // Per-file comment counts → a small badge on rows that have any. (#1)
  commentCounts?: Map<string, number>;
}) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(selected);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Row-windowing state (#virtual): only rows within [scrollTop, +viewportH] mount.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Track the scroller's scrollTop (rAF-gated, like the diff pane) and its height to
  // drive the row window below. Off-screen rows never mount, so this is what keeps a
  // 2000-file tree at ~viewport-sized DOM. useLayoutEffect measures before paint so
  // the first frame already renders the right slice (no flash). (#virtual)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setScrollTop(el.scrollTop); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => setViewportH(el.clientHeight));
      ro.observe(el);
    }
    return () => { el.removeEventListener("scroll", onScroll); ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Follow the diff viewport (scroll-spy): when the top file changes, select it
  // so the highlight tracks what you're looking at. Keyboard/click selection
  // still wins until the diff scrolls again (which is when `selected` changes). (#r3)
  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    if (selected) setActivePath(selected);
  }, [selected]);

  // ⌘⇧F focuses the file search (Escape on the input clears, then blurs). Plain
  // ⌘F is the in-code find (handled by the diff pane), so the file filter moved
  // to ⌘⇧F. (#find)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "f" || e.key === "F") && (e.metaKey || e.ctrlKey) && e.shiftKey) {
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

  // Flatten the currently-visible rows (with depth) for both keyboard nav and row
  // windowing. While searching, every dir is force-open so matches are never hidden
  // behind a collapsed parent. Depth replaces the old nested-div indentation. (#virtual)
  const visible: { node: TreeNode; depth: number }[] = useMemo(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    (function walk(nodes: TreeNode[], depth: number) {
      for (const n of nodes) {
        out.push({ node: n, depth });
        if (n.kind === "dir" && (searching || !collapsed.has(n.path))) walk(n.children, depth + 1);
      }
    })(roots, 0);
    return out;
  }, [roots, collapsed, searching]);

  // Keep the active row in view. It may be windowed out of the DOM, so its offset is
  // computed from ROW_H (index math) rather than measured — leaves ~one row of
  // padding, honors reduced-motion else glides, so the highlight tracks keyboard nav,
  // clicks, and scroll-spy smoothly. Re-runs on tree reshape too, but only nudges if
  // the active row actually fell out of view. (#r3/#virtual)
  useEffect(() => {
    if (!activePath) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = visible.findIndex((r) => r.node.path === activePath);
    if (idx < 0) return;
    const rowTop = TREE_PAD_Y + idx * ROW_H;
    const pad = ROW_H + 6; // one neighbor row of breathing room
    let top: number | null = null;
    if (rowTop - pad < el.scrollTop) {
      top = Math.max(0, rowTop - pad);
    } else if (rowTop + ROW_H + pad > el.scrollTop + el.clientHeight) {
      top = rowTop + ROW_H + pad - el.clientHeight;
    }
    if (top === null) return; // already comfortably in view
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }, [activePath, visible]);

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
  // Debounced hover-prefetch: only fire after the pointer rests ~110ms, so
  // sweeping the mouse down the tree doesn't kick off a build per row. (#perf)
  const onHoverFile = (path: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (path && onPrefetch) hoverTimer.current = setTimeout(() => onPrefetch(path), 110);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (!visible.length) return;
    const idx = visible.findIndex((r) => r.node.path === activePath);
    const cur = idx >= 0 ? visible[idx].node : undefined;
    // Arrows loop and jump-scroll the diff to the file; Enter toggles viewed;
    // left/right collapse/expand dirs. (#r5)
    const moveTo = (n: TreeNode) => (n.kind === "file" ? selectFile(n.path) : setActivePath(n.path));
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(visible[idx < 0 ? 0 : (idx + 1) % visible.length].node);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(visible[idx <= 0 ? visible.length - 1 : idx - 1].node);
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
      const first = visible.find((r) => r.node.kind === "file")?.node;
      if (first) selectFile(first.path);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = visible[0]?.node;
      if (first) { setActivePath(first.path); scrollRef.current?.focus(); }
    }
  }

  const h: RowHandlers = {
    activePath,
    collapsed: searching ? NO_COLLAPSE : collapsed,
    viewedFiles,
    commentCounts: commentCounts ?? EMPTY_COUNTS,
    flat: mode === "list",
    onToggleDir: toggleDir,
    onSelectFile: selectFile,
    onToggleViewed,
    onHoverFile,
  };

  // Row window: which slice of `visible` is on screen (+ overscan). winH falls back to
  // a tall value before the layout effect measures (and in happy-dom tests) so small
  // trees render fully on first paint; totalH sizes the spacer that preserves scroll. (#virtual)
  const winH = viewportH || 1200;
  const rowCount = visible.length;
  const firstRow = Math.max(0, Math.floor((scrollTop - TREE_PAD_Y) / ROW_H) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop - TREE_PAD_Y + winH) / ROW_H) + OVERSCAN_ROWS);
  const totalH = rowCount * ROW_H + TREE_PAD_Y * 2;

  return (
    // Top + left padding mirrors the diff pane's card inset (PAD) so the three
    // panes share one floating rhythm. (#pad)
    <div className="flex min-h-0 flex-1 flex-col pl-1.5 pt-3.5">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[12px]">
        <span
          className={`inline-block shrink-0 whitespace-nowrap select-none rounded-md px-2 py-0.5 text-[13px] tabular-nums ${allViewed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
          title="Files viewed"
        >
          <span className={`font-medium ${allViewed ? "" : "text-foreground"}`}>{viewedFiles.size}</span>
          <span className="opacity-80">{" / "}{files.length} viewed</span>
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
          {totalAdds > 0 && <span className="text-emerald-500">+{fmtCount(totalAdds)}</span>}{" "}
          {totalDels > 0 && <span className="text-rose-500">−{fmtCount(totalDels)}</span>}
        </span>
        <div className="flex shrink-0 items-center gap-1">
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
            <ToggleGroupItem value="list" aria-label="List" title="List" className="size-5 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><List className="size-3.5" /></ToggleGroupItem>
            <ToggleGroupItem value="tree" aria-label="Tree" title="Tree" className="size-5 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><ListTree className="size-3.5" /></ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Search sits below the header (a little breathing room) and on top of the
          tree/list; ⌘F focuses it. (#3) */}
      <div className="relative mt-1.5 shrink-0 px-2 py-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search files…"
          aria-label="Search files"
          // Paths aren't prose — kill macOS autocorrect/capitalization/suggestions.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="h-7 w-full rounded-md border border-input bg-card pl-8 pr-12 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/25 focus:border-ring"
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
          <Kbd keys="⌘⇧F" className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2" />
        )}
      </div>

      <div
        ref={scrollRef}
        data-testid="files-tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto pl-2 pr-1.5 outline-none"
      >
        {searching && roots.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">No files match “{query}”.</div>
        ) : (
          <div className="relative" style={{ height: totalH }}>
            {visible.slice(firstRow, lastRow).map(({ node, depth }, k) => (
              <Row key={node.path} node={node} depth={depth} top={TREE_PAD_Y + (firstRow + k) * ROW_H} h={h} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

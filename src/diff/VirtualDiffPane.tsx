// src/diff/VirtualDiffPane.tsx
//
// Row-virtualized diff renderer (Settings → Diff renderer → Virtual).
//
// The whole point: render only the diff rows on screen, instead of mounting every
// file's full table. @git-diff-view renders a file's entire table (~250ms, ~700
// nodes) with no way to render just the visible rows — that single fact forced
// every bad trade (skeleton vs huge DOM). Here we keep @git-diff-view's *model*
// (parse + diff + tokenize, ~24ms) and render the rows ourselves, windowed.
//
// We virtualize PER FILE (not one flat list over all rows) so a file's model can
// build lazily as it nears the viewport, while off-screen files are fixed-height
// placeholders with zero rows rendered. Code rows are ROW_H tall (no wrap), so a
// row's y-offset is exact arithmetic — EXCEPT comment threads (variable height),
// whose measured heights fold into each file's reported body height.
//
// Supports unified + split, line/range/file comments, word-level intra-line diff,
// jump-to-comment, and the viewed toggle.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { getSyntaxLineTemplate } from "@git-diff-view/file";
import { SplitSide } from "@git-diff-view/react";
import { toDiffFile } from "./toDiffFile";
import { CommentThread } from "../review/CommentThread";
import type { Anchor, Comment, FileDiff, FileEntry, Side, Target } from "../types";
import type { DiffLayout } from "./useDiffLayout";
import { useFileDiffCache } from "./useFileDiffCache";

const ROW_H = 22;
const HEADER_H = 37; // sticky file header (border-box)
const OVERSCAN = 1500; // px of rows to render/build beyond the viewport each way
const GIANT_CHANGED_LINES = 500;
const EST_BLOCK_H = 96; // placeholder height for a comment thread before it measures

type Model = ReturnType<typeof toDiffFile>;
type ChangeRange = { location: number; length: number } | undefined;

// Build the model once per (fileDiff, theme, layout). The expensive parse + diff +
// tokenize lives here (~24ms); after this, row + token access is O(1) reads.
const modelCache = new WeakMap<FileDiff, Map<string, Model>>();
function buildModel(fd: FileDiff, theme: "light" | "dark", layout: DiffLayout): Model {
  let byKey = modelCache.get(fd);
  if (!byKey) modelCache.set(fd, (byKey = new Map()));
  const key = `${theme}|${layout}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const f = toDiffFile(fd);
  f.initTheme(theme);
  if (layout === "split") f.buildSplitDiffLines(); else f.buildUnifiedDiffLines();
  byKey.set(key, f);
  return f;
}
const rowCountOf = (m: Model, layout: DiffLayout) => (layout === "split" ? m.splitLineLength : m.unifiedLineLength);

// Pure, change-size-only helpers — module scope so they're stable references and
// not rebuilt every render (and safe to read inside memos without being deps).
const isGiant = (e: FileEntry) => e.additions + e.deletions >= GIANT_CHANGED_LINES;
const estBodyH = (e: FileEntry) => Math.max(1, Math.round((e.additions + e.deletions) * 1.1) + 6) * ROW_H;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function syntaxHtml(model: Model, side: Side, lineNumber: number, raw?: string): string {
  let html = "";
  try { html = getSyntaxLineTemplate(side === "old" ? model.getOldSyntaxLine(lineNumber) : model.getNewSyntaxLine(lineNumber)) ?? ""; } catch { /* raw */ }
  return html || escapeHtml(raw ?? "");
}
const changeRangeOf = (diff: { changes?: unknown } | undefined): ChangeRange =>
  (diff?.changes as { range?: ChangeRange } | undefined)?.range;

// The code area: highlighted line + a brighter tint over exactly the changed
// characters (word-level diff). Monospace ⇒ char N is at N`ch`, so the overlay
// lines up without splitting tokens.
function Code({ html, range, changeBg }: { html: string; range: ChangeRange; changeBg: string }) {
  return (
    <code className="diff-line-syntax-raw relative flex-1 overflow-hidden whitespace-pre pr-3">
      {range && range.length > 0 && (
        <span aria-hidden className={`pointer-events-none absolute inset-y-[2.5px] rounded ${changeBg}`} style={{ left: `${range.location}ch`, width: `${range.length}ch` }} />
      )}
      <span className="relative whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
    </code>
  );
}

const gutterCls = "w-12 shrink-0 select-none border-r border-border/40 px-1 text-right text-[11px] text-muted-foreground/60 tabular-nums cursor-ns-resize";
const addBtnCls = "absolute z-10 hidden size-[18px] -translate-y-1/2 items-center justify-center rounded bg-primary text-primary-foreground shadow-sm group-hover:flex";

// Unified row: old# · new# · marker · code, hover `+` to comment, gutters drag-select.
function Row({ model, index, top, selected, onComment }: { model: Model; index: number; top: number; selected: boolean; onComment: (side: Side, line: number) => void }) {
  const line = model.getUnifiedLine(index);
  const hasOld = line.oldLineNumber != null, hasNew = line.newLineNumber != null;
  const kind = hasOld && hasNew ? "ctx" : hasNew ? "add" : hasOld ? "del" : "hunk";
  const side: Side = hasNew ? "new" : "old";
  const html = kind === "hunk" ? escapeHtml(line.value ?? "") : syntaxHtml(model, side, (hasNew ? line.newLineNumber : line.oldLineNumber)!, line.value);
  const bg = kind === "add" ? "bg-emerald-500/10" : kind === "del" ? "bg-rose-500/10" : kind === "hunk" ? "bg-muted/40" : "";
  const range = kind === "add" || kind === "del" ? changeRangeOf(line.diff) : undefined;
  const marker = kind === "add" ? "+" : kind === "del" ? "−" : "";
  const markerColor = kind === "add" ? "text-emerald-500" : kind === "del" ? "text-rose-500" : "text-transparent";
  return (
    <div data-row-index={index} className={`group absolute inset-x-0 flex items-stretch font-mono text-[13px] leading-[22px] ${bg} ${selected ? "!bg-primary/20" : ""}`} style={{ top, height: ROW_H }}>
      {kind !== "hunk" && (
        <button type="button" onClick={() => onComment(side, (hasNew ? line.newLineNumber : line.oldLineNumber)!)} aria-label={`comment on line ${hasNew ? line.newLineNumber : line.oldLineNumber}`} title="Comment (drag line numbers for a range)" className={`left-[5.5rem] top-1/2 ${addBtnCls}`}>
          <MessageSquarePlus className="size-3" />
        </button>
      )}
      <span data-gutter="old" className={gutterCls}>{hasOld ? line.oldLineNumber : ""}</span>
      <span data-gutter="new" className={gutterCls}>{hasNew ? line.newLineNumber : ""}</span>
      <span className={`w-4 shrink-0 select-none text-center ${markerColor}`}>{marker}</span>
      <Code html={html} range={kind === "hunk" ? undefined : range} changeBg={kind === "add" ? "bg-emerald-500/20" : "bg-rose-500/20"} />
    </div>
  );
}

// One side of a split row.
function SplitCell({ model, side, line, changed, selected, onComment, className }: { model: Model; side: Side; line: import("@git-diff-view/file").SplitLineItem; changed: boolean; selected: boolean; onComment: (side: Side, line: number) => void; className: string }) {
  const has = line.lineNumber != null;
  const ln = line.lineNumber!;
  const html = has ? syntaxHtml(model, side, ln, line.value) : "";
  const baseBg = changed ? (side === "old" ? "bg-rose-500/10" : "bg-emerald-500/10") : "";
  const range = changed ? changeRangeOf(line.diff) : undefined;
  return (
    <div className={`relative flex items-stretch ${selected ? "!bg-primary/15" : baseBg} ${className}`}>
      {has && (
        <button type="button" onClick={() => onComment(side, ln)} aria-label={`comment on ${side} line ${ln}`} title="Comment (drag line numbers for a range)" className={`left-[3.2rem] top-1/2 ${addBtnCls}`}>
          <MessageSquarePlus className="size-3" />
        </button>
      )}
      <span data-gutter={side} className={gutterCls}>{has ? ln : ""}</span>
      {has ? <Code html={html} range={range} changeBg={side === "old" ? "bg-rose-500/20" : "bg-emerald-500/20"} /> : <span className="flex-1" />}
    </div>
  );
}

// Split row: old | new, each a cell.
function SplitRow({ model, index, top, selected, onComment }: { model: Model; index: number; top: number; selected: boolean; onComment: (side: Side, line: number) => void }) {
  const left = model.getSplitLeftLine(index), right = model.getSplitRightLine(index);
  const leftHas = left.lineNumber != null, rightHas = right.lineNumber != null;
  const leftChanged = leftHas && (!rightHas || !!changeRangeOf(left.diff));
  const rightChanged = rightHas && (!leftHas || !!changeRangeOf(right.diff));
  return (
    <div data-row-index={index} className="group absolute inset-x-0 flex items-stretch font-mono text-[13px] leading-[22px]" style={{ top, height: ROW_H }}>
      <SplitCell model={model} side="old" line={left} changed={leftChanged} selected={selected} onComment={onComment} className="w-1/2 min-w-0 border-r border-border/60" />
      <SplitCell model={model} side="new" line={right} changed={rightChanged} selected={selected} onComment={onComment} className="w-1/2 min-w-0" />
    </div>
  );
}

// An inline comment thread anchored under a row. Measures its own (variable) height.
function CommentBlock({ id, top, comments, onEdit, onDelete, onHeight }: { id: string; top: number; comments: Comment[]; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void; onHeight: (id: string, h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);
  return (
    <div ref={ref} className="absolute inset-x-0 px-3 py-2" style={{ top }}>
      <CommentThread comments={comments} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

interface Block { id: string; index: number; comments: Comment[] }

const VFileSection = memo(function VFileSection({
  entry, theme, layout, cache, collapsed, viewed, onToggleCollapse, onToggleViewed, view, comments, onAddComment, onAddFileComment, onEditComment, onDeleteComment, reportBodyHeight, registerRef,
}: {
  entry: FileEntry; theme: "light" | "dark"; layout: DiffLayout;
  cache: ReturnType<typeof useFileDiffCache>;
  collapsed: boolean; viewed: boolean;
  onToggleCollapse: (path: string) => void;
  onToggleViewed: (path: string) => void;
  view: [number, number] | null; // body-relative visible window [top, bottom] px, or null off-screen
  comments: Comment[];
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  reportBodyHeight: (path: string, h: number) => void;
  registerRef: (path: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { registerRef(entry.path, ref.current); return () => registerRef(entry.path, null); }, [entry.path]);

  const visible = view != null && !collapsed;
  const fd = useFileDiffCacheEntry(cache, entry.path, visible);
  const model = useMemo(() => (fd && visible ? buildModel(fd, theme, layout) : null), [fd, theme, layout, visible]);
  const rowCount = model ? rowCountOf(model, layout) : 0;

  // Comment blocks: file-scope → index -1 (top); line/range → the row they anchor.
  const blocks = useMemo<Block[]>(() => {
    if (!model) return [];
    const out: Block[] = [];
    const fileScoped = comments.filter((c) => c.scope === "file");
    if (fileScoped.length) out.push({ id: "__file__", index: -1, comments: fileScoped });
    const byKey = new Map<string, Block>();
    for (const c of comments) {
      const a = c.anchor;
      if (!a || a.startLine == null || c.scope === "file") continue;
      const key = `${a.side}:${a.startLine}`;
      let b = byKey.get(key);
      if (!b) {
        const ss = a.side === "old" ? SplitSide.old : SplitSide.new;
        const idx = layout === "split" ? model.getSplitLineIndexByLineNumber(a.startLine, ss) : model.getUnifiedLineIndexByLineNumber(a.startLine, ss);
        if (idx == null || idx < 0) continue;
        b = { id: key, index: idx, comments: [] };
        byKey.set(key, b);
      }
      b.comments.push(c);
    }
    out.push(...byKey.values());
    return out.sort((x, y) => x.index - y.index);
  }, [model, comments, layout]);

  const [blockH, setBlockH] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, h: number) => {
    setBlockH((prev) => (Math.abs((prev[id] ?? -1) - h) < 1 ? prev : { ...prev, [id]: h }));
  }, []);
  const heightOf = (b: Block) => blockH[b.id] ?? EST_BLOCK_H;
  const commentAbove = (i: number) => { let s = 0; for (const b of blocks) { if (b.index < i) s += heightOf(b); else break; } return s; };
  const rowTop = (i: number) => i * ROW_H + commentAbove(i);
  const totalCommentH = blocks.reduce((s, b) => s + heightOf(b), 0);
  const bodyH = collapsed ? 0 : rowCount * ROW_H + totalCommentH;
  useEffect(() => { if (model) reportBodyHeight(entry.path, bodyH); }, [model, entry.path, bodyH, reportBodyHeight]);

  // Create a line/range anchor and add an (empty) comment, mirroring the classic renderer.
  const commentLine = useCallback((side: Side, lineNumber: number) => {
    if (!fd || lineNumber == null) return;
    const content = side === "old" ? fd.oldContent : fd.newContent;
    const snippet = (content ?? "").split("\n").slice(lineNumber - 1, lineNumber).join("\n");
    onAddComment({ file: entry.path, side, startLine: lineNumber, endLine: null, snippet }, "");
  }, [fd, entry.path, onAddComment]);

  // Drag the line-number gutter → range comment.
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const onGutterPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!model || !fd) return;
    const t = e.target as HTMLElement;
    const gut = t.closest("[data-gutter]"), rowEl = t.closest("[data-row-index]");
    if (!gut || !rowEl) return;
    const side: Side = gut.getAttribute("data-gutter") === "old" ? "old" : "new";
    const startIdx = Number(rowEl.getAttribute("data-row-index"));
    e.preventDefault();
    setSel({ a: startIdx, b: startIdx });
    let head = startIdx;
    const lineAt = (i: number): number | undefined => layout === "split"
      ? (side === "old" ? model.getSplitLeftLine(i) : model.getSplitRightLine(i)).lineNumber
      : (side === "old" ? model.getUnifiedLine(i).oldLineNumber : model.getUnifiedLine(i).newLineNumber);
    const onMove = (ev: PointerEvent) => {
      const r = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-row-index]");
      if (r) { head = Number(r.getAttribute("data-row-index")); setSel({ a: startIdx, b: head }); }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setSel(null);
      if (head === startIdx) return; // a click, not a drag — `+` handles single lines
      const lo = Math.min(startIdx, head), hi = Math.max(startIdx, head);
      let startLine: number | null = null, endLine: number | null = null;
      for (let i = lo; i <= hi; i++) { const n = lineAt(i); if (n != null) { if (startLine == null) startLine = n; endLine = n; } }
      if (startLine != null && endLine != null && endLine > startLine) {
        const content = side === "old" ? fd.oldContent : fd.newContent;
        const snippet = (content ?? "").split("\n").slice(startLine - 1, endLine).join("\n");
        onAddComment({ file: entry.path, side, startLine, endLine, snippet }, "");
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [model, fd, entry.path, layout, onAddComment]);
  const selLo = sel ? Math.min(sel.a, sel.b) : -1, selHi = sel ? Math.max(sel.a, sel.b) : -1;

  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;

  // Visible rows for the window (rowTop is monotonic; binary-search the bounds).
  const renderRows: number[] = [];
  if (model && view) {
    const findRowAtY = (y: number) => { let lo = 0, hi = rowCount; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rowTop(m) <= y) lo = m; else hi = m - 1; } return lo; };
    const first = Math.max(0, findRowAtY(view[0]));
    const last = Math.min(rowCount, findRowAtY(view[1]) + 2);
    for (let i = first; i < last; i++) renderRows.push(i);
  }

  return (
    <div ref={ref} data-file={entry.path} className="border-b border-border/70">
      <div className="group/h sticky top-0 z-20 flex items-center gap-1 border-b border-border/70 bg-background px-3" style={{ height: HEADER_H }}>
        <button type="button" className="absolute inset-0" aria-label={collapsed ? `expand ${entry.path}` : `collapse ${entry.path}`} onClick={() => onToggleCollapse(entry.path)} />
        <span className={`pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 ${viewed ? "opacity-55 group-hover/h:opacity-100" : ""}`}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-medium text-foreground">{base}</span>
          </span>
        </span>
        <span className={`pointer-events-none relative shrink-0 text-[12px] tabular-nums ${viewed ? "opacity-55 group-hover/h:opacity-100" : ""}`}>
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
        <button type="button" onClick={(e) => { e.stopPropagation(); onAddFileComment(entry.path, ""); }} aria-label={`comment on ${entry.path}`} title="Comment on file" className="relative z-10 flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
          <MessageSquarePlus className="size-4" />
        </button>
        <button type="button" onClick={(e) => { e.stopPropagation(); onToggleViewed(entry.path); }} aria-pressed={viewed} aria-label={`viewed ${entry.path}`} title="Mark viewed" className={`relative z-10 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] ${viewed ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
          <span className={`flex size-4 items-center justify-center rounded-[5px] border transition-colors ${viewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80"}`}>
            {viewed && <Check className="size-3" strokeWidth={3} />}
          </span>
          Viewed
        </button>
      </div>
      {!collapsed && (
        <div className="relative" style={{ height: bodyH }} onPointerDown={onGutterPointerDown}>
          {model && layout === "split" && renderRows.map((i) => <SplitRow key={i} model={model} index={i} top={rowTop(i)} selected={i >= selLo && i <= selHi} onComment={commentLine} />)}
          {model && layout !== "split" && renderRows.map((i) => <Row key={i} model={model} index={i} top={rowTop(i)} selected={i >= selLo && i <= selHi} onComment={commentLine} />)}
          {model && blocks.map((b) => (
            <CommentBlock key={b.id} id={b.id} top={b.index < 0 ? 0 : rowTop(b.index) + ROW_H} comments={b.comments} onEdit={onEditComment} onDelete={onDeleteComment} onHeight={onHeight} />
          ))}
        </div>
      )}
    </div>
  );
});

function useFileDiffCacheEntry(cache: ReturnType<typeof useFileDiffCache>, path: string, want: boolean) {
  const subscribe = useCallback((cb: () => void) => cache.subscribe(path, cb), [cache, path]);
  const fd = useSyncExternalStore(subscribe, () => cache.get(path));
  useEffect(() => { if (want && !fd) void cache.load(path); }, [cache, path, want, fd]);
  return fd;
}

export function VirtualDiffPane({
  target, files, theme, layout, viewedFiles, comments, jump, onVisibleFileChange, onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; theme: "light" | "dark"; layout: DiffLayout;
  viewedFiles: Set<string>; comments: Comment[];
  jump?: { file: string; commentId?: string; n: number } | null;
  onVisibleFileChange?: (file: string) => void;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);
  const paneRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(path, el); else sectionRefs.current.delete(path);
  }, []);
  const jumpPin = useRef<string | null>(null);
  const jumpPinTimer = useRef(0);
  const jumpTimer = useRef(0);
  const pinComment = useRef<string | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // Measured per-file body heights (comment threads are variable-height, so a
  // file's body isn't pure arithmetic). Kept in state, not a ref: offsets derive
  // from it during render, and reading a ref in render is unsafe under React
  // Compiler. setState coalesces, so a burst of reports is one commit.
  const [bodyHeights, setBodyHeights] = useState<Record<string, number>>({});
  const reportBodyHeight = useCallback((path: string, h: number) => {
    setBodyHeights((prev) => (prev[path] === h ? prev : { ...prev, [path]: h }));
  }, []);
  // Layout flip re-renders every diff at a different height — drop stale heights.
  // Adjust-on-prop-change during render (not an effect) so offsets recompute in
  // the same pass the new layout renders.
  const [prevLayout, setPrevLayout] = useState(layout);
  if (prevLayout !== layout) { setPrevLayout(layout); setBodyHeights({}); }

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const collapsedFor = useCallback((e: FileEntry) => overrides[e.path] ?? (viewedFiles.has(e.path) || isGiant(e)), [overrides, viewedFiles]);
  const toggleCollapse = useCallback((path: string) => {
    const e = files.find((f) => f.path === path);
    const cur = overrides[path] ?? (e ? viewedFiles.has(path) || isGiant(e) : false);
    setOverrides((o) => ({ ...o, [path]: !cur }));
  }, [files, overrides, viewedFiles]);

  // When viewed flips, drop any manual collapse override so the section follows
  // viewed (collapse on view / expand on un-view), matching the classic pane.
  const prevViewed = useRef(viewedFiles);
  useEffect(() => {
    const prev = prevViewed.current; prevViewed.current = viewedFiles;
    const flipped = files.filter((f) => viewedFiles.has(f.path) !== prev.has(f.path)).map((f) => f.path);
    if (!flipped.length) return;
    setOverrides((o) => { let ch = false; const n = { ...o }; for (const p of flipped) if (p in n) { delete n[p]; ch = true; } return ch ? n : o; });
  }, [viewedFiles, files]);

  const commentsByFile = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments) { const f = c.anchor?.file; if (f) (m.get(f) ?? m.set(f, []).get(f)!).push(c); }
    return m;
  }, [comments]);
  const noComments = useMemo<Comment[]>(() => [], []);

  const { offsets, total } = useMemo(() => {
    const offs: number[] = [];
    let top = 0;
    for (const f of files) {
      offs.push(top);
      const collapsed = collapsedFor(f);
      const bh = collapsed ? 0 : (bodyHeights[f.path] ?? estBodyH(f));
      top += HEADER_H + bh + 1; // +1 border-b
    }
    return { offsets: offs, total: top };
  }, [files, collapsedFor, bodyHeights]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    setViewportH(pane.clientHeight);
    let raf = 0;
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; setScrollTop(pane.scrollTop); }); };
    pane.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => setViewportH(pane.clientHeight));
    ro.observe(pane);
    return () => { pane.removeEventListener("scroll", onScroll); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Expand the jump target (drop any collapse override) during render so offsets
  // are already correct when the scroll effect below runs — adjust-on-prop-change
  // keyed on the jump nonce, not a setState inside the effect.
  const [prevJumpN, setPrevJumpN] = useState<number>();
  if (jump && jump.n !== prevJumpN) {
    setPrevJumpN(jump.n);
    setOverrides((o) => (o[jump.file] === false ? o : { ...o, [jump.file]: false }));
  }

  // Jump: file → scroll + pin its offset; comment → center the comment node, both
  // held as files above resolve (offsets shift). Released after settle / user input.
  useEffect(() => {
    if (!jump) return;
    const { file, commentId } = jump;
    const i = files.findIndex((f) => f.path === file);
    if (i < 0) return;
    const pane = paneRef.current;
    if (!pane) return;

    if (commentId) {
      void cache.load(file);
      pinComment.current = commentId;
      const attempt = (tries: number) => {
        const node = pane.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) as HTMLElement | null;
        if (node) { node.scrollIntoView({ block: "center" }); return; }
        (sectionRefs.current.get(file) ?? (pane.querySelector(`[data-file="${CSS.escape(file)}"]`) as HTMLElement | null))?.scrollIntoView({ block: "start" });
        if (tries < 40) jumpTimer.current = window.setTimeout(() => attempt(tries + 1), 40);
      };
      attempt(0);
      const release = () => { pinComment.current = null; clearTimeout(jumpPinTimer.current); };
      jumpPinTimer.current = window.setTimeout(release, 1800);
      pane.addEventListener("wheel", release, { passive: true, once: true });
      pane.addEventListener("pointerdown", release, { once: true });
      window.addEventListener("keydown", release, { once: true });
      return () => {
        clearTimeout(jumpTimer.current); clearTimeout(jumpPinTimer.current); pinComment.current = null;
        pane.removeEventListener("wheel", release); pane.removeEventListener("pointerdown", release); window.removeEventListener("keydown", release);
      };
    }

    jumpPin.current = file;
    pane.scrollTop = Math.max(0, Math.min(offsets[i], pane.scrollHeight - pane.clientHeight));
    const release = () => { jumpPin.current = null; clearTimeout(jumpPinTimer.current); };
    jumpPinTimer.current = window.setTimeout(release, 1500);
    pane.addEventListener("wheel", release, { passive: true, once: true });
    pane.addEventListener("pointerdown", release, { once: true });
    window.addEventListener("keydown", release, { once: true });
    return () => {
      clearTimeout(jumpPinTimer.current); jumpPin.current = null;
      pane.removeEventListener("wheel", release); pane.removeEventListener("pointerdown", release); window.removeEventListener("keydown", release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.n]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const cid = pinComment.current;
    if (cid) {
      const node = pane.querySelector(`[data-comment-id="${CSS.escape(cid)}"]`) as HTMLElement | null;
      if (node) {
        const pr = pane.getBoundingClientRect(), nr = node.getBoundingClientRect();
        const want = Math.max(0, Math.min(pane.scrollTop + (nr.top + nr.height / 2) - (pr.top + pr.height / 2), pane.scrollHeight - pane.clientHeight));
        if (Math.abs(pane.scrollTop - want) > 1) pane.scrollTop = want;
      }
      return;
    }
    const p = jumpPin.current;
    if (!p) return;
    const i = files.findIndex((f) => f.path === p);
    if (i < 0) return;
    const want = Math.max(0, Math.min(offsets[i], pane.scrollHeight - pane.clientHeight));
    if (Math.abs(pane.scrollTop - want) > 1) pane.scrollTop = want;
  }, [offsets, total, files]);

  const lastVisible = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleFileChange) return;
    let current = files[0]?.path ?? null;
    for (let i = 0; i < files.length; i++) { if (offsets[i] <= scrollTop + 4) current = files[i].path; else break; }
    if (current && current !== lastVisible.current) { lastVisible.current = current; onVisibleFileChange(current); }
  }, [scrollTop, files, offsets, onVisibleFileChange]);

  const top0 = scrollTop - OVERSCAN, bot0 = scrollTop + viewportH + OVERSCAN;

  return (
    <div ref={paneRef} className="h-full overflow-auto" data-testid="diff-pane">
      {/* diff-tailwindcss-wrapper + data-theme scope @git-diff-view's hljs token
          colors onto our rows; the gdv layer sits below `utilities`, so our layout wins. */}
      <div className="diff-tailwindcss-wrapper" data-theme={theme} style={{ position: "relative", height: total }}>
        {files.map((entry, i) => {
          const collapsed = collapsedFor(entry);
          const bh = collapsed ? 0 : (bodyHeights[entry.path] ?? estBodyH(entry));
          const sectionTop = offsets[i], bodyTop = sectionTop + HEADER_H;
          const onScreen = viewportH > 0 && !collapsed && bodyTop + bh > top0 && bodyTop < bot0;
          const view: [number, number] | null = onScreen ? [Math.max(0, top0 - bodyTop), Math.max(0, bot0 - bodyTop)] : null;
          return (
            <div key={entry.path} style={{ position: "absolute", top: sectionTop, left: 0, right: 0 }}>
              <VFileSection
                entry={entry} theme={theme} layout={layout} cache={cache}
                collapsed={collapsed} viewed={viewedFiles.has(entry.path)}
                onToggleCollapse={toggleCollapse} onToggleViewed={onToggleViewed}
                view={view}
                comments={view ? (commentsByFile.get(entry.path) ?? noComments) : noComments}
                onAddComment={onAddComment} onAddFileComment={onAddFileComment} onEditComment={onEditComment} onDeleteComment={onDeleteComment}
                reportBodyHeight={reportBodyHeight} registerRef={registerRef}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

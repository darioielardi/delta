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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, Copy, ExternalLink, Eye, FileQuestion, FileX, MessageSquarePlus, Plus } from "lucide-react";
import { getSyntaxLineTemplate } from "@git-diff-view/file";
import { SplitSide } from "@git-diff-view/react";
import { Button } from "@/components/ui/button";
import { api } from "../api";
import { getEditorPref } from "../editor";
import { toDiffFile } from "./toDiffFile";
import { CommentThread } from "../review/CommentThread";
import { DiffFind } from "./DiffFind";
import type { Anchor, Comment, FileDiff, FileEntry, Side, Target } from "../types";
import type { DiffLayout } from "./useDiffLayout";
import { useFileDiffCache } from "./useFileDiffCache";
import { anchorScrollTopOnCollapse } from "./anchorScroll";
import { useCodeFont, rowHeightFor } from "../codeFont";

const HEADER_H = 40; // sticky file header (border-box); content is vertically centered. (#card)
// Row height + char width are derived from the code-font-size pref at render (the
// rows' actual font-size/line-height come from the --code-fs/--code-lh CSS vars
// set on the wrapper; the JS row height drives the windowing math and must match).
// CH_PX is calibrated at 13px and scaled with the chosen size.
const CH_PX = 7.85; // ≈ width of one mono char at 13px (SF Mono/Menlo) — only used to decide whether a file overflows the pane (→ enable horizontal scroll); layout itself uses exact `ch` units (#hscroll)
// Left-accent colors for changed lines, mirroring the comment-range accent. (#border)
const ADD_ACCENT = "var(--color-emerald-500)";
const DEL_ACCENT = "var(--color-rose-500)";
const OVERSCAN = 1500; // px of rows to render/build beyond the viewport each way
const GIANT_CHANGED_LINES = 500;
const EST_BLOCK_H = 96; // placeholder height for a comment thread before it measures
const PLACEHOLDER_BODY_H = 72; // fixed body height for binary / deleted placeholders (#11, shared layout #5, padding #8)
const CONTEXT = 3; // unchanged lines kept around each change before folding (#10)
const EXPAND_STEP = 25; // lines revealed per fold expand click (#2)
// Card layout: each file's diff is a rounded card inset from the pane edges by
// PAD, with GAP of empty space between cards. These fold into the offset math
// below so row-windowing stays exact. PAD is also the reference gutter: the first
// card's top inset, and where a sticky header pins (so a stuck header keeps the
// same space above it as the resting first card). (#card)
const PAD = 14;
const GAP = 10;

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
const estBodyH = (e: FileEntry, rowH: number) => Math.max(1, Math.round((e.additions + e.deletions) * 1.1) + 6) * rowH;
// Binary + deleted files render a fixed-height placeholder, never a model — so
// their reserved height is KNOWN, not estimated. Using this (not estBodyH) as the
// offset fallback keeps them exact even after a bodyHeights reset (layout flip),
// when a placeholder section can't re-report (its effect deps don't change). (#9)
const estReserved = (e: FileEntry, rowH: number) => (e.binary || e.status === "deleted" ? PLACEHOLDER_BODY_H : estBodyH(e, rowH));

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

// In-code find (#find). A highlight mark over matched characters; RowMark adds
// the split side so a row's two cells can each render only their own matches.
type Mark = { col: number; len: number; active: boolean };
type RowMark = Mark & { side: Side };
// A match reported up to the pane: model row + side + char offset, plus the
// body-relative y of its row (rough scroll target before exact centering).
interface FindMatch { file: string; modelIndex: number; side: Side; col: number; len: number; y: number }

// Find options (#find): match case + whole-word, mirroring an editor's find box.
type FindOpts = { caseSensitive: boolean; wholeWord: boolean };
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Compile the query into a global regex once per (query, opts). Whole-word wraps
// the term in word-boundary lookarounds (word = [A-Za-z0-9_]). Returns null for
// an empty query (or the rare invalid pattern after escaping).
function buildFindRegex(q: string, opts: FindOpts): RegExp | null {
  if (!q) return null;
  let pat = escapeRegExp(q);
  if (opts.wholeWord) pat = `(?<![A-Za-z0-9_])${pat}(?![A-Za-z0-9_])`;
  try { return new RegExp(pat, opts.caseSensitive ? "g" : "gi"); } catch { return null; }
}
// Non-overlapping occurrences of a compiled regex in `text`.
function occurrencesOf(re: RegExp, text: string): { col: number; len: number }[] {
  re.lastIndex = 0;
  const out: { col: number; len: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ col: m.index, len: m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++; // guard against a zero-length match
  }
  return out;
}

// The code area: highlighted line + a brighter tint over exactly the changed
// characters (word-level diff). Monospace ⇒ char N is at N`ch`, so the overlay
// lines up without splitting tokens.
function Code({ html, range, changeBg, marks }: { html: string; range: ChangeRange; changeBg: string; marks?: Mark[] }) {
  return (
    <code className="diff-line-syntax-raw relative flex-1 whitespace-pre pr-3">
      {range && range.length > 0 && (
        <span aria-hidden className={`pointer-events-none absolute inset-y-[2.5px] rounded ${changeBg}`} style={{ left: `${range.location}ch`, width: `${range.length}ch` }} />
      )}
      {/* Find highlights sit behind the text (which is `relative` below). The
          active match gets a stronger fill + ring. (#find) */}
      {marks?.map((m, k) => (
        <span key={k} aria-hidden className={`pointer-events-none absolute inset-y-px rounded-[2px] ${m.active ? "bg-amber-400/80 ring-1 ring-amber-500" : "bg-amber-400/30"}`} style={{ left: `${m.col}ch`, width: `${m.len}ch` }} />
      ))}
      <span className="relative whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
    </code>
  );
}

const gutterCls = "w-12 shrink-0 select-none border-r border-border/40 px-1 text-right text-[length:var(--gutter-fs,11px)] text-muted-foreground/60 tabular-nums cursor-ns-resize";
const addBtnCls = "absolute z-10 hidden size-5 -translate-y-1/2 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm group-hover:flex hover:brightness-110";
// Wide files scroll horizontally, but the scrollbar itself is hidden — the always-
// on thin bar flickered as the outer pane scrolled. Trackpad/shift-wheel still
// scroll the row. (#hscroll)
const HIDE_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

// A changed/empty row's tint is a translucent color. On the body it sits over
// bg-code; but the sticky gutter rail must stay OPAQUE (it masks code scrolling
// under it on horizontal scroll). So on the rail we composite the same tint over
// an opaque var(--code) — making the green/red/blue/void fill reach the card's
// very left edge (the gutter) while the rail still masks. (#2/#3)
const railBg = (tint: string | null) => (tint ? `linear-gradient(${tint}, ${tint}), var(--code)` : undefined);
const mix = (color: string, pct: number) => `color-mix(in oklch, ${color} ${pct}%, transparent)`;

// Unified row: old# · new# · marker · code, hover `+` to comment, gutters drag-select.
function Row({ model, index, top, selected, highlighted, onComment, marks }: { model: Model; index: number; top: number; selected: boolean; highlighted: boolean; onComment: (side: Side, line: number) => void; marks?: RowMark[] }) {
  const line = model.getUnifiedLine(index);
  const hasOld = line.oldLineNumber != null, hasNew = line.newLineNumber != null;
  const kind = hasOld && hasNew ? "ctx" : hasNew ? "add" : hasOld ? "del" : "hunk";
  const side: Side = hasNew ? "new" : "old";
  const html = kind === "hunk" ? escapeHtml(line.value ?? "") : syntaxHtml(model, side, (hasNew ? line.newLineNumber : line.oldLineNumber)!, line.value);
  const range = kind === "add" || kind === "del" ? changeRangeOf(line.diff) : undefined;
  const marker = kind === "add" ? "+" : kind === "del" ? "−" : "";
  const markerColor = kind === "add" ? "text-emerald-500" : kind === "del" ? "text-rose-500" : "text-transparent";
  // Row tint, as a translucent color so it can fill the body AND composite over
  // the opaque gutter rail — so the fill spans gutter→edge, not just the code. (#3)
  const tint = selected ? mix("var(--primary)", 20)
    : kind === "add" ? mix("var(--color-emerald-500)", 15)
    : kind === "del" ? mix("var(--color-rose-500)", 15)
    : kind === "hunk" ? mix("var(--muted)", 40)
    : highlighted ? mix("var(--primary)", 6)
    : null;
  // Left accent: a commented range wins (primary), else changed lines get a
  // green/red edge mirroring the comment accent. (#border)
  const accent = highlighted ? "var(--primary)" : kind === "add" ? ADD_ACCENT : kind === "del" ? DEL_ACCENT : undefined;
  return (
    <div data-row-index={index} className="group absolute left-0 flex items-stretch font-mono text-[length:var(--code-fs,13px)] leading-[var(--code-lh,22px)]" style={{ top, height: "var(--code-lh,22px)", width: "var(--rw)", minWidth: "100%", background: tint ?? undefined }}>
      {kind !== "hunk" && (
        <button type="button" onClick={() => onComment(side, (hasNew ? line.newLineNumber : line.oldLineNumber)!)} aria-label={`comment on line ${hasNew ? line.newLineNumber : line.oldLineNumber}`} title="Comment (drag line numbers for a range)" className={`left-[5.25rem] top-1/2 ${addBtnCls}`}>
          <Plus className="size-3.5" strokeWidth={2.5} />
        </button>
      )}
      {/* Sticky rail: pins the line-number gutters + marker to the left on
          horizontal scroll and masks the code scrolling under it. Opaque bg-code,
          or the row tint composited over it so the fill reaches the left edge.
          The changed/commented accent rides the rail. (#2/#3) */}
      <div className="sticky left-0 z-[1] flex items-stretch bg-code" style={{ background: railBg(tint), boxShadow: accent ? `inset 3px 0 0 ${accent}` : undefined }}>
        <span data-gutter="old" className={gutterCls}>{hasOld ? line.oldLineNumber : ""}</span>
        <span data-gutter="new" className={gutterCls}>{hasNew ? line.newLineNumber : ""}</span>
        <span className={`w-4 shrink-0 select-none text-center ${markerColor}`}>{marker}</span>
      </div>
      <Code html={html} range={kind === "hunk" ? undefined : range} changeBg={kind === "add" ? "bg-emerald-400/25" : "bg-rose-400/25"} marks={marks} />
    </div>
  );
}

// One side's cell of a split row, absolutely positioned inside its column. The
// gutter is a sticky rail (like the unified row) so it stays pinned and masks the
// code that scrolls under it on horizontal scroll. The two columns are separate
// scroll containers (synced), so each side scrolls within its own half. (#2/#10)
function SplitColCell({ model, side, index, top, changed, highlighted, selected, onComment, marks }: { model: Model; side: Side; index: number; top: number; changed: boolean; highlighted: boolean; selected: boolean; onComment: (side: Side, line: number) => void; marks?: RowMark[] }) {
  const line = side === "old" ? model.getSplitLeftLine(index) : model.getSplitRightLine(index);
  const has = line.lineNumber != null;
  const ln = line.lineNumber!;
  const html = has ? syntaxHtml(model, side, ln, line.value) : "";
  // No line here → the change is on the other side; tint the whole empty row
  // (gutter included) a neutral "void" so it reads as absent, not context. (#2)
  // Otherwise: selected / changed (red old, green new) / commented, as a
  // translucent tint that also fills the gutter rail (#3).
  const tint = !has ? mix("var(--muted-foreground)", 7)
    : selected ? mix("var(--primary)", 15)
    : changed ? (side === "old" ? mix("var(--color-rose-500)", 15) : mix("var(--color-emerald-500)", 15))
    : highlighted ? mix("var(--primary)", 6)
    : null;
  const range = changed ? changeRangeOf(line.diff) : undefined;
  const accent = changed ? (side === "old" ? DEL_ACCENT : ADD_ACCENT) : highlighted ? "var(--primary)" : undefined;
  return (
    <div data-row-index={index} className="group absolute left-0 flex w-full items-stretch font-mono text-[length:var(--code-fs,13px)] leading-[var(--code-lh,22px)]" style={{ top, height: "var(--code-lh,22px)", background: tint ?? undefined }}>
      {has && (
        <button type="button" onClick={() => onComment(side, ln)} aria-label={`comment on ${side} line ${ln}`} title="Comment (drag line numbers for a range)" className={`left-12 top-1/2 ${addBtnCls}`}>
          <Plus className="size-3.5" strokeWidth={2.5} />
        </button>
      )}
      <div className="sticky left-0 z-[1] flex items-stretch bg-code" style={{ background: railBg(tint), boxShadow: accent ? `inset 3px 0 0 ${accent}` : undefined }}>
        <span data-gutter={side} className={gutterCls}>{has ? ln : ""}</span>
      </div>
      {has ? <Code html={html} range={range} changeBg={side === "old" ? "bg-rose-400/25" : "bg-emerald-400/25"} marks={marks} /> : <span className="flex-1" />}
    </div>
  );
}

// A visual row is either a real model line, or a fold standing in for a run of
// hidden unchanged lines [start,end] (inclusive model indices). (#10)
type VisualRow = { kind: "line"; index: number } | { kind: "fold"; start: number; end: number; count: number };

// Stand-in for a folded run of unchanged lines. A single reveal control shows the
// direction that has adjacent shown code to extend from — ↓ (down) when there's
// code above the gap, ↑ (up) when there's code below; a gap anchored to both file
// ends shows both. Clicking the label expands the whole gap. The blue tint reads
// as "collapsed, expandable" — clearly not code. The bg spans the full row width
// (var(--rw)) so it never truncates on horizontal scroll, like changed rows.
// (#3/#4)
function FoldRow({ top, count, showDown, showUp, onDown, onUp, onAll }: { top: number; count: number; showDown: boolean; showUp: boolean; onDown: () => void; onUp: () => void; onAll: () => void }) {
  // Either direction reveals at most the remaining gap, so don't promise 25 when
  // fewer are left.
  const step = Math.min(EXPAND_STEP, count);
  return (
    <div
      data-fold
      className="absolute left-0 flex items-stretch bg-primary/10 font-mono text-[length:var(--fold-fs,12px)] font-medium leading-[var(--code-lh,22px)] text-muted-foreground"
      style={{ top, height: "var(--code-lh,22px)", width: "var(--rw)", minWidth: "100%" }}
    >
      <div className="sticky left-0 flex h-full w-24 shrink-0 border-r border-border/40">
        {showDown && (
          <button type="button" onClick={onDown} title={`Show ${step} more line${step === 1 ? "" : "s"} (down)`} className="flex flex-1 items-center justify-center transition-colors hover:bg-primary/20 hover:text-foreground">
            <ChevronDown className="size-[18px]" />
          </button>
        )}
        {showUp && (
          <button type="button" onClick={onUp} title={`Show ${step} more line${step === 1 ? "" : "s"} (up)`} className={`flex flex-1 items-center justify-center transition-colors hover:bg-primary/20 hover:text-foreground ${showDown ? "border-l border-border/40" : ""}`}>
            <ChevronUp className="size-[18px]" />
          </button>
        )}
      </div>
      <button type="button" onClick={onAll} title="Expand all hidden lines" className="sticky left-24 flex flex-1 items-center px-3 text-left tabular-nums transition-colors hover:text-foreground">
        {count} hidden line{count === 1 ? "" : "s"}
      </button>
    </div>
  );
}

// An inline comment thread anchored under a row. Measures its own (variable) height.
function CommentBlock({ id, top, comments, onEdit, onDelete, onToggleResolved, onHeight }: { id: string; top: number; comments: Comment[]; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void; onToggleResolved: (id: string) => void; onHeight: (id: string, h: number) => void }) {
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
    // `delta-comment-ui` flips the comment UI back to the sans font (the diff
    // wrapper forces mono on everything inside it) and restores app colors. (#3)
    <div ref={ref} className="delta-comment-ui absolute inset-x-0 px-3 pb-3 pt-1.5" style={{ top }}>
      <CommentThread comments={comments} onEdit={onEdit} onDelete={onDelete} onToggleResolved={onToggleResolved} />
    </div>
  );
}

interface Block { id: string; index: number; comments: Comment[] }

const VFileSection = memo(function VFileSection({
  entry, theme, layout, cache, collapsed, viewed, headerSolo, repoPath, onToggleCollapse, onToggleViewed, view, paneW, rowH, chPx, query, caseSensitive, wholeWord, activeMatch, onMatches, forceModel, comments, onAddComment, onAddFileComment, onEditComment, onDeleteComment, onToggleResolvedComment, reportBodyHeight, registerRef,
}: {
  entry: FileEntry; theme: "light" | "dark"; layout: DiffLayout;
  cache: ReturnType<typeof useFileDiffCache>;
  collapsed: boolean; viewed: boolean;
  headerSolo: boolean; // body fully scrolled under the stuck header → round its bottom corners (#6)
  repoPath: string; // absolute repo/worktree root — joined with entry.path to open in an editor (#editor)
  onToggleCollapse: (path: string) => void;
  onToggleViewed: (path: string) => void;
  view: [number, number] | null; // body-relative visible window [top, bottom] px, or null off-screen
  paneW: number; // diff pane client width — decides if a file overflows → horizontal scroll (#hscroll)
  rowH: number; // code row height (px), from the font-size pref; must match the --code-lh the rows render at
  chPx: number; // ~mono char width (px) at the chosen size — only for the overflow check (#hscroll)
  query: string; // in-code find query ("" when find is closed) (#find)
  caseSensitive: boolean; wholeWord: boolean; // find options (#find)
  activeMatch: { modelIndex: number; side: Side; col: number } | null; // the active match, if it lives in THIS file
  onMatches: (path: string, matches: FindMatch[]) => void; // report this file's matches up for the global list
  forceModel: boolean; // find active → build the model even off-screen/collapsed so this file is searchable (#find)
  comments: Comment[];
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onToggleResolvedComment: (id: string) => void;
  reportBodyHeight: (path: string, h: number) => void;
  registerRef: (path: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { registerRef(entry.path, ref.current); return () => registerRef(entry.path, null); }, [entry.path]);

  // Split view renders the two sides as separate horizontal-scroll columns;
  // mirror one's scrollLeft onto the other so the old/new sides stay aligned. The
  // guard flag avoids the feedback loop between the two onScroll handlers. (#10)
  const oldColRef = useRef<HTMLDivElement>(null);
  const newColRef = useRef<HTMLDivElement>(null);
  const colSyncing = useRef(false);
  const syncCols = useCallback((from: "old" | "new") => {
    if (colSyncing.current) return;
    const src = (from === "old" ? oldColRef : newColRef).current;
    const dst = (from === "old" ? newColRef : oldColRef).current;
    if (!src || !dst || dst.scrollLeft === src.scrollLeft) return;
    colSyncing.current = true;
    dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => { colSyncing.current = false; });
  }, []);

  // Binary files have no textual diff; deleted files hide their (removed) content
  // behind a reveal so the pane isn't dominated by deletions. Both render a fixed-
  // height placeholder instead of a diff model — restoring the classic pane's
  // treatment that the virtual refactor dropped. (#11)
  const isBinary = entry.binary;
  const isDeleted = entry.status === "deleted";
  const [revealed, setRevealed] = useState(false);
  const showPlaceholder = !collapsed && (isBinary || (isDeleted && !revealed));

  // Build the model when on-screen, or whenever find is active (forceModel) so
  // every searchable file contributes matches even while off-screen/collapsed.
  const wantModel = !isBinary && (!isDeleted || revealed) && (forceModel || (view != null && !collapsed));
  const fd = useFileDiffCacheEntry(cache, entry.path, wantModel);
  const model = useMemo(() => (fd && wantModel ? buildModel(fd, theme, layout) : null), [fd, theme, layout, wantModel]);
  const rowCount = model ? rowCountOf(model, layout) : 0;

  // Horizontal scroll (#hscroll): rows are widened to the file's longest line so
  // long code can scroll instead of clipping. Width is exact `ch` (mono) + fixed
  // gutter px; min-width:100% on the rows keeps narrow files full-bleed. Only
  // files genuinely wider than the pane get overflow-x — the scrollbar itself is
  // hidden (it flickered on scroll; trackpad/shift-wheel still scroll).
  const maxCols = useMemo(() => {
    if (!fd) return 0;
    let m = 0;
    for (const c of [fd.oldContent, fd.newContent]) {
      if (!c) continue;
      for (const ln of c.split("\n")) if (ln.length > m) m = ln.length;
    }
    return m;
  }, [fd]);
  const rowWidthCss = layout === "split" ? `calc(120px + ${2 * maxCols}ch)` : `calc(124px + ${maxCols}ch)`;
  const colWidthCss = `calc(60px + ${maxCols}ch)`; // one split column's content width (gutter + code) (#10)
  const rowPx = (layout === "split" ? 120 : 124) + maxCols * chPx * (layout === "split" ? 2 : 1);
  const wide = paneW > 0 && rowPx > paneW - 2 * PAD - 2; // card is inset by PAD each side, minus its 1px borders

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
      // Anchor multi-line (range) comments to the LAST selected line, not the
      // first, so the thread sits under the end of the span. (#anchor)
      const anchorLine = a.endLine ?? a.startLine;
      const key = `${a.side}:${anchorLine}`;
      let b = byKey.get(key);
      if (!b) {
        const ss = a.side === "old" ? SplitSide.old : SplitSide.new;
        const idx = layout === "split" ? model.getSplitLineIndexByLineNumber(anchorLine, ss) : model.getUnifiedLineIndexByLineNumber(anchorLine, ss);
        if (idx == null || idx < 0) continue;
        b = { id: key, index: idx, comments: [] };
        byKey.set(key, b);
      }
      b.comments.push(c);
    }
    out.push(...byKey.values());
    return out.sort((x, y) => x.index - y.index);
  }, [model, comments, layout]);

  // Lines that carry a comment must always stay visible (never folded). (#10)
  const commentedRows = useMemo(() => {
    const s = new Set<number>();
    for (const b of blocks) if (b.index >= 0) s.add(b.index);
    return s;
  }, [blocks]);

  // Per-gap reveal counts (lines shown from the top / bottom of the hidden run),
  // keyed `${start}_${end}`. Each ↓/↑ adds EXPAND_STEP; "all" reveals the rest. (#2)
  const [expansions, setExpansions] = useState<Map<string, { top: number; bottom: number }>>(() => new Map());
  const growFold = useCallback((key: string, dir: "top" | "bottom" | "all") => {
    setExpansions((p) => {
      const n = new Map(p);
      const cur = n.get(key) ?? { top: 0, bottom: 0 };
      n.set(key, dir === "all" ? { top: Number.MAX_SAFE_INTEGER, bottom: 0 } : { ...cur, [dir]: cur[dir] + EXPAND_STEP });
      return n;
    });
  }, []);

  // Model rows covered by a multi-line (range) comment — force-shown and given a
  // left accent so the commented span reads as one group. (#7)
  const rangeRows = useMemo(() => {
    const s = new Set<number>();
    if (!model) return s;
    for (const c of comments) {
      const a = c.anchor;
      if (!a || a.startLine == null || a.endLine == null || a.endLine <= a.startLine || c.scope === "file") continue;
      const ss = a.side === "old" ? SplitSide.old : SplitSide.new;
      const lo = layout === "split" ? model.getSplitLineIndexByLineNumber(a.startLine, ss) : model.getUnifiedLineIndexByLineNumber(a.startLine, ss);
      const hi = layout === "split" ? model.getSplitLineIndexByLineNumber(a.endLine, ss) : model.getUnifiedLineIndexByLineNumber(a.endLine, ss);
      if (lo == null || hi == null || lo < 0 || hi < 0) continue;
      for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) s.add(i);
    }
    return s;
  }, [model, comments, layout]);

  // Only show changed lines plus CONTEXT unchanged lines around each change (and
  // around every commented line); collapse the rest into expandable fold rows.
  // Built per (model, layout, comments, expanded) — not per scroll frame. (#10)
  const { visualRows, modelToVisual } = useMemo(() => {
    const rows: VisualRow[] = [];
    const m2v = new Map<number, number>();
    if (!model) return { visualRows: rows, modelToVisual: m2v };
    const isChanged = (i: number): boolean => {
      if (layout === "split") {
        const left = model.getSplitLeftLine(i), right = model.getSplitRightLine(i);
        const lh = left.lineNumber != null, rh = right.lineNumber != null;
        return (lh && (!rh || !!changeRangeOf(left.diff))) || (rh && (!lh || !!changeRangeOf(right.diff)));
      }
      const l = model.getUnifiedLine(i);
      return !(l.oldLineNumber != null && l.newLineNumber != null); // add / del / hunk
    };
    const shown = new Array<boolean>(rowCount).fill(false);
    for (let i = 0; i < rowCount; i++) {
      if (isChanged(i) || commentedRows.has(i) || rangeRows.has(i)) {
        for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rowCount - 1, i + CONTEXT); j++) shown[j] = true;
      }
    }
    const pushLine = (k: number) => { m2v.set(k, rows.length); rows.push({ kind: "line", index: k }); };
    let i = 0;
    while (i < rowCount) {
      if (shown[i]) { pushLine(i); i++; continue; }
      let j = i;
      while (j < rowCount && !shown[j]) j++;
      const start = i, end = j - 1, len = end - start + 1;
      const ex = expansions.get(`${start}_${end}`);
      const top = ex ? Math.min(ex.top, len) : 0;
      const bottom = ex ? Math.min(ex.bottom, len - top) : 0;
      for (let k = start; k < start + top; k++) pushLine(k);
      const midStart = start + top, midEnd = end - bottom, remaining = midEnd - midStart + 1;
      // A 1-line leftover isn't worth a fold row (same height, needless click).
      if (remaining >= 2) rows.push({ kind: "fold", start, end, count: remaining });
      else for (let k = midStart; k <= midEnd; k++) pushLine(k);
      for (let k = end - bottom + 1; k <= end; k++) pushLine(k);
      i = j;
    }
    return { visualRows: rows, modelToVisual: m2v };
  }, [model, layout, rowCount, commentedRows, rangeRows, expansions]);
  const visualCount = visualRows.length;

  // In-code find (#find): scan SHOWN lines for the query. Matches map to model
  // rows (folded/hidden lines are skipped). `fileMatches` feeds the global list;
  // `marksByRow` drives the per-row highlight overlays. y is the row's body-top
  // (rows × ROW_H — a rough scroll target; exact centering is done via the DOM).
  const q = query.trim();
  const { fileMatches, marksByRow } = useMemo(() => {
    const fm: FindMatch[] = [];
    const mbr = new Map<number, RowMark[]>();
    const re = buildFindRegex(q, { caseSensitive, wholeWord });
    if (!model || !re) return { fileMatches: fm, marksByRow: mbr };
    const add = (i: number, side: Side, text: string) => {
      const occ = occurrencesOf(re, text);
      if (!occ.length) return;
      const vr = modelToVisual.get(i);
      if (vr == null) return; // line folded away — not visible, skip
      const y = vr * rowH;
      let arr = mbr.get(i);
      if (!arr) mbr.set(i, (arr = []));
      for (const o of occ) {
        fm.push({ file: entry.path, modelIndex: i, side, col: o.col, len: o.len, y });
        arr.push({ side, col: o.col, len: o.len, active: false });
      }
    };
    if (layout === "split") {
      for (let i = 0; i < rowCount; i++) {
        const l = model.getSplitLeftLine(i), r = model.getSplitRightLine(i);
        if (l.lineNumber != null && l.value) add(i, "old", l.value);
        if (r.lineNumber != null && r.value) add(i, "new", r.value);
      }
    } else {
      for (let i = 0; i < rowCount; i++) {
        const l = model.getUnifiedLine(i);
        if (l.value == null) continue;
        const hasNew = l.newLineNumber != null, hasOld = l.oldLineNumber != null;
        if (hasNew || hasOld) add(i, hasNew ? "new" : "old", l.value);
      }
    }
    return { fileMatches: fm, marksByRow: mbr };
  }, [model, q, caseSensitive, wholeWord, layout, rowCount, modelToVisual, entry.path]);
  useEffect(() => { onMatches(entry.path, fileMatches); }, [entry.path, fileMatches, onMatches]);
  // The active match's row gets its matching mark flagged active (cheap, at render).
  const rowMarks = (mi: number): RowMark[] | undefined => {
    const arr = marksByRow.get(mi);
    if (!arr || !activeMatch || activeMatch.modelIndex !== mi) return arr;
    return arr.map((m) => ({ ...m, active: m.side === activeMatch.side && m.col === activeMatch.col }));
  };

  const [blockH, setBlockH] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, h: number) => {
    setBlockH((prev) => (Math.abs((prev[id] ?? -1) - h) < 1 ? prev : { ...prev, [id]: h }));
  }, []);
  const heightOf = (b: Block) => blockH[b.id] ?? EST_BLOCK_H;
  // A block's visual anchor row (file-scope = -1, above everything). Blocks are
  // sorted by model index, which maps monotonically to visual rows, so the
  // running sum below can break early. (#10)
  const blockVa = (b: Block) => (b.index < 0 ? -1 : modelToVisual.get(b.index) ?? 0);
  const commentAbove = (v: number) => { let s = 0; for (const b of blocks) { if (blockVa(b) < v) s += heightOf(b); else break; } return s; };
  const visualRowTop = (v: number) => v * rowH + commentAbove(v);
  const totalCommentH = blocks.reduce((s, b) => s + heightOf(b), 0);
  const bodyH = collapsed ? 0 : showPlaceholder ? PLACEHOLDER_BODY_H : visualCount * rowH + totalCommentH;
  // Report a definite height once it's known — model built, or a fixed-height
  // placeholder shown — so the parent's offsets are exact. (#10/#11)
  useEffect(() => { if (model || showPlaceholder) reportBodyHeight(entry.path, bodyH); }, [model, showPlaceholder, isBinary, entry.path, bodyH, reportBodyHeight]);

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

  // Copy the file name (basename) to the clipboard, flashing a ✓ on the button.
  // Selection is disabled app-wide for a native feel, so this is the quick way to
  // grab a name without selecting it. (#copyname)
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(0);
  const copyName = useCallback(() => {
    void navigator.clipboard.writeText(base).then(() => {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch((e) => console.error("copy file name:", e));
  }, [base]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // Visible visual rows for the window (visualRowTop is monotonic; binary-search).
  const renderVisual: number[] = [];
  if (model && view) {
    const findVAtY = (y: number) => { let lo = 0, hi = visualCount; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (visualRowTop(m) <= y) lo = m; else hi = m - 1; } return lo; };
    const first = Math.max(0, findVAtY(view[0]));
    const last = Math.min(visualCount, findVAtY(view[1]) + 2);
    for (let v = first; v < last; v++) renderVisual.push(v);
  }

  // One split column's inner content: only the code cells for `side` (folds +
  // comments are full-width and rendered once over both columns). Rendered for
  // each column with its own static scroll ref so the two stay independently
  // scrollable + synced. (#10)
  const splitColumnInner = (side: Side) => (
    <div className="relative h-full" style={{ width: colWidthCss, minWidth: "100%" }}>
      {model && renderVisual.map((v) => {
        const vr = visualRows[v];
        if (vr.kind !== "line") return null;
        const idx = vr.index;
        const left = model.getSplitLeftLine(idx), right = model.getSplitRightLine(idx);
        const leftHas = left.lineNumber != null, rightHas = right.lineNumber != null;
        const changed = side === "old"
          ? leftHas && (!rightHas || !!changeRangeOf(left.diff))
          : rightHas && (!leftHas || !!changeRangeOf(right.diff));
        return (
          <SplitColCell
            key={idx} model={model} side={side} index={idx} top={visualRowTop(v)}
            changed={changed} highlighted={rangeRows.has(idx)} selected={idx >= selLo && idx <= selHi}
            onComment={commentLine} marks={rowMarks(idx)?.filter((m) => m.side === side)}
          />
        );
      })}
    </div>
  );

  return (
    // Borders live on the header + body, not this wrapper, so a stuck header can
    // float with a canvas GAP above it (the wrapper is transparent there). (#7)
    <div ref={ref} data-file={entry.path} className="rounded-lg shadow-xs dark:shadow-none">
      {/* Canvas backdrop pinned exactly behind the sticky header (z below it).
          The header's rounded top corners are transparent at the notch; without
          this, code rows scrolling under the header peek through those corners.
          The backdrop fills the corner notches with the canvas color instead, so
          the header reads as a clean floating card edge. Zero-height sticky shell
          adds no flow space; its absolute child spans the header box. (#6) */}
      <div aria-hidden className="pointer-events-none sticky z-10 h-0" style={{ top: PAD }}>
        <div className="absolute inset-x-0 top-0 bg-background" style={{ height: HEADER_H }} />
      </div>
      <div className={`group/h sticky z-20 flex items-center gap-2 border-x border-t border-border bg-code px-3 transition-[border-radius] duration-150 ${collapsed || headerSolo ? "rounded-lg border-b" : "rounded-t-lg border-b border-border/70"}`} style={{ height: HEADER_H, top: PAD }}>
        {/* Full-box collapse target. The label/counts above it are
            pointer-events-none, so hovering anywhere in the header (padding +
            gaps included) reaches this button and — via peer-hover — lights the
            chevron like a ghost button. The action buttons sit on top (relative),
            so hovering them does NOT trigger it. (#2) */}
        <button
          type="button"
          onClick={() => onToggleCollapse(entry.path)}
          aria-label={collapsed ? `expand ${entry.path}` : `collapse ${entry.path}`}
          aria-expanded={!collapsed}
          className="peer/col absolute inset-0"
        />
        <span className="pointer-events-none relative flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors peer-hover/col:bg-foreground/[0.06] peer-hover/col:text-foreground">
          <ChevronRight className={`size-4 transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`} />
        </span>
        <span className={`pointer-events-none relative flex min-w-0 flex-1 items-center gap-1 ${viewed ? "opacity-55 group-hover/h:opacity-100" : ""}`}>
          <span className="min-w-0 truncate text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-medium text-foreground">{base}</span>
          </span>
          {/* Reveals on header hover (and keyboard focus); ✓ flashes after a copy. */}
          <button
            type="button"
            onClick={copyName}
            aria-label={`copy file name ${base}`}
            title={copied ? "Copied" : "Copy file name"}
            className="pointer-events-auto relative ml-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover/h:opacity-100"
          >
            {copied ? <Check className="size-3 text-emerald-500" strokeWidth={3} /> : <Copy className="size-3" />}
          </button>
        </span>
        <span className={`pointer-events-none relative shrink-0 text-[12px] tabular-nums ${viewed ? "opacity-55 group-hover/h:opacity-100" : ""}`}>
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { void api.openInEditor(getEditorPref(), repoPath, entry.path).catch((e) => console.error("open in editor:", e)); }}
          aria-label={`open ${entry.path} in editor`}
          title="Open in editor"
          className="relative h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onAddFileComment(entry.path, "")}
          aria-label={`comment on ${entry.path}`}
          title="Comment on file"
          className="relative h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        >
          <MessageSquarePlus className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onToggleViewed(entry.path)}
          aria-pressed={viewed}
          aria-label={`viewed ${entry.path}`}
          title="Mark viewed"
          className={`delta-ui-font relative h-6 shrink-0 gap-1.5 px-2 text-[12px] ${viewed ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          <span className={`flex size-4 items-center justify-center rounded-[5px] border transition-colors ${viewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80"}`}>
            {viewed && <Check className="size-3" strokeWidth={3} />}
          </span>
          Viewed
        </Button>
      </div>
      {!collapsed && (
        <div
          className={`relative rounded-b-lg border-x border-b border-border bg-code ${layout !== "split" && wide ? `overflow-x-auto overflow-y-hidden ${HIDE_SCROLLBAR}` : "overflow-hidden"}`}
          style={{ height: bodyH, overscrollBehaviorY: "auto" /* always chain a vertical wheel to the pane, not only over h-scrollable files — the app-wide overscroll-behavior:none otherwise traps it on every card (#hscroll) */, "--rw": rowWidthCss } as CSSProperties}
          onPointerDown={onGutterPointerDown}
        >
          {isBinary ? (
            <div className="delta-ui-font flex h-full items-center gap-3 pl-5 pr-3 text-[13px] text-muted-foreground">
              <FileQuestion className="size-4 shrink-0 opacity-70" />
              <span>Unsupported file — binary or non-text content.</span>
            </div>
          ) : isDeleted && !revealed ? (
            <div className="delta-ui-font flex h-full items-center gap-3 pl-5 pr-3 text-[13px] text-muted-foreground">
              <FileX className="size-4 shrink-0 text-rose-500/80" />
              <span>File deleted</span>
              <button
                type="button"
                onClick={() => { setRevealed(true); void cache.load(entry.path); }}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Eye className="size-4" /> Show deleted content
              </button>
            </div>
          ) : (
            <>
              {/* Code: unified renders one column of rows; split renders the two
                  sides as separate synced horizontal-scroll columns. Folds +
                  comments span both sides, so they're rendered once below (over the
                  columns), not inside either. (#10) */}
              {model && (layout === "split" ? (
                <>
                  <div
                    ref={oldColRef}
                    onScroll={() => syncCols("old")}
                    className={`absolute inset-y-0 left-0 w-1/2 overflow-x-auto overflow-y-hidden border-r border-border/60 ${HIDE_SCROLLBAR}`}
                    style={{ overscrollBehaviorY: "auto" }}
                  >
                    {splitColumnInner("old")}
                  </div>
                  <div
                    ref={newColRef}
                    onScroll={() => syncCols("new")}
                    className={`absolute inset-y-0 left-1/2 w-1/2 overflow-x-auto overflow-y-hidden ${HIDE_SCROLLBAR}`}
                    style={{ overscrollBehaviorY: "auto" }}
                  >
                    {splitColumnInner("new")}
                  </div>
                </>
              ) : (
                renderVisual.map((v) => {
                  const vr = visualRows[v];
                  if (vr.kind !== "line") return null;
                  const hl = rangeRows.has(vr.index);
                  return <Row key={vr.index} model={model} index={vr.index} top={visualRowTop(v)} selected={vr.index >= selLo && vr.index <= selHi} highlighted={hl} onComment={commentLine} marks={rowMarks(vr.index)} />;
                })
              ))}
              {/* Folds (full row width) — shared by both layouts; in split the body
                  doesn't scroll, so the bg fills the visible card width. (#3/#4) */}
              {model && renderVisual.map((v) => {
                const vr = visualRows[v];
                if (vr.kind !== "fold") return null;
                const key = `${vr.start}_${vr.end}`;
                // ↓ extends from shown code above the gap, ↑ from shown code below;
                // a gap touching both file ends (no anchor) shows both. (#4)
                const canDown = vr.start > 0, canUp = vr.end < rowCount - 1;
                const both = !canDown && !canUp;
                return <FoldRow key={`fold-${vr.start}`} top={visualRowTop(v)} count={vr.count} showDown={canDown || both} showUp={canUp || both} onDown={() => growFold(key, "top")} onUp={() => growFold(key, "bottom")} onAll={() => growFold(key, "all")} />;
              })}
              {model && blocks.map((b) => (
                <CommentBlock key={b.id} id={b.id} top={b.index < 0 ? 0 : visualRowTop(blockVa(b)) + rowH} comments={b.comments} onEdit={onEditComment} onDelete={onDeleteComment} onToggleResolved={onToggleResolvedComment} onHeight={onHeight} />
              ))}
            </>
          )}
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
  target, files, theme, layout, viewedFiles, comments, jump, invalidate, onVisibleFileChange, onToggleViewed, onAddComment, onAddFileComment, onEditComment, onDeleteComment, onToggleResolvedComment,
}: {
  target: Target; files: FileEntry[]; theme: "light" | "dark"; layout: DiffLayout;
  viewedFiles: Set<string>; comments: Comment[];
  jump?: { file: string; commentId?: string; n: number } | null;
  // Reload signal from the header Refresh button: { paths: null } reloads all
  // mounted files, otherwise just the listed ones. The nonce re-fires it. (#12)
  invalidate?: { paths: string[] | null; n: number } | null;
  onVisibleFileChange?: (file: string) => void;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor, body: string) => void;
  onAddFileComment: (file: string, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onToggleResolvedComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);

  // Code-font geometry from the size pref. rowH drives ALL the windowing math and
  // must equal the px the rows actually render at (the --code-lh CSS var, set on
  // the wrapper below). At the default 13px this is 22 — identical to before.
  const { size: codeSize } = useCodeFont();
  const rowH = rowHeightFor(codeSize);
  const chPx = (CH_PX * codeSize) / 13; // overflow check only; scales with size

  // Drop + reload changed files when the user hits Refresh; a fresh FileDiff
  // invalidates its cached model (WeakMap-keyed) so the section rebuilds. (#12)
  useEffect(() => {
    if (!invalidate) return;
    if (invalidate.paths === null) cache.refreshAll();
    else cache.invalidate(invalidate.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidate?.n]);

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
  const [viewportW, setViewportW] = useState(0); // pane width → per-file horizontal-overflow test (#hscroll)

  // In-code find (#find): ⌘F opens a floating box; matches are reported up from
  // each file section into matchesByFile, flattened in file order for next/prev.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findScrollTimer = useRef(0);
  const [matchesByFile, setMatchesByFile] = useState<Map<string, FindMatch[]>>(() => new Map());
  const findActive = findOpen && query.trim().length > 0;
  const onMatches = useCallback((path: string, m: FindMatch[]) => {
    setMatchesByFile((prev) => {
      const had = prev.has(path);
      if (m.length === 0) {
        if (!had) return prev;
        const next = new Map(prev); next.delete(path); return next;
      }
      const next = new Map(prev); next.set(path, m); return next;
    });
  }, []);
  // ⌘F opens find (⌘⇧F is the file filter, handled in FilesPanel). Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "f" || e.key === "F") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => { findInputRef.current?.focus(); findInputRef.current?.select(); });
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false); setQuery("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen]);
  const closeFind = useCallback(() => { setFindOpen(false); setQuery(""); }, []);
  // Reset to the first match whenever the query changes — adjusted during render
  // via a prev-value guard rather than an effect (no cascading commit).
  const [prevFindQuery, setPrevFindQuery] = useState(query);
  if (prevFindQuery !== query) { setPrevFindQuery(query); setActiveIdx(0); }
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
    let top = PAD; // top padding above the first card
    for (const f of files) {
      offs.push(top);
      const collapsed = collapsedFor(f);
      const bh = collapsed ? 0 : (bodyHeights[f.path] ?? estReserved(f, rowH));
      top += HEADER_H + bh + GAP; // card body + gap to the next card
    }
    return { offsets: offs, total: top - GAP + PAD }; // trailing gap → bottom padding
  }, [files, collapsedFor, bodyHeights, rowH]);

  // Scroll anchoring on collapse (#viewed-anchor). Folding a file shut drops its body
  // height; without this, any of that height above the viewport top yanks the visible
  // content upward. Native overflow-anchor can't help — sections are absolutely
  // positioned in a JS-sized container — so we compensate scrollTop manually, pre-paint
  // (useLayoutEffect, before the shifted frame can show). We snapshot each file's
  // collapse state per render and act only on a single file going expanded → collapsed;
  // new already-collapsed files (async load / refresh) and bulk folds are left alone.
  const prevCollapsed = useRef<Map<string, boolean> | null>(null);
  useLayoutEffect(() => {
    const curr = new Map<string, boolean>();
    for (const f of files) curr.set(f.path, collapsedFor(f));
    const prev = prevCollapsed.current;
    prevCollapsed.current = curr;
    if (prev === null) return; // first run only records the baseline
    let fresh = -1;
    for (let i = 0; i < files.length; i++) {
      // Expanded last render, collapsed now — a genuine fold of an existing file.
      if (curr.get(files[i].path) === true && prev.get(files[i].path) === false) {
        if (fresh >= 0) return; // more than one folded this commit — don't fight it
        fresh = i;
      }
    }
    if (fresh < 0) return;
    const pane = paneRef.current;
    if (!pane) return;
    const bodyHeight = bodyHeights[files[fresh].path] ?? estReserved(files[fresh], rowH);
    const want = anchorScrollTopOnCollapse(pane.scrollTop, offsets[fresh], bodyHeight, HEADER_H, PAD);
    if (want == null) return;
    const next = Math.min(want, Math.max(0, pane.scrollHeight - pane.clientHeight));
    if (Math.abs(next - pane.scrollTop) > 1) {
      pane.scrollTop = next;
      setScrollTop(next); // keep the row window in sync this frame (onScroll is rAF-gated)
    }
  }, [collapsedFor, files, offsets, bodyHeights, rowH]);

  // Flatten matches in file (tree) order → global next/prev list. (#find)
  const allMatches = useMemo(() => {
    const out: FindMatch[] = [];
    for (const f of files) { const m = matchesByFile.get(f.path); if (m) out.push(...m); }
    return out;
  }, [files, matchesByFile]);
  const matchCount = allMatches.length;
  const activeMatch = matchCount > 0 ? allMatches[Math.min(activeIdx, matchCount - 1)] : null;
  const [navNonce, setNavNonce] = useState(0);
  const stepMatch = useCallback((dir: 1 | -1) => {
    setActiveIdx((i) => (matchCount === 0 ? 0 : (i + dir + matchCount) % matchCount));
    setNavNonce((n) => n + 1);
  }, [matchCount]);
  // Auto-scroll to the first match once results land for a query — but only once
  // per query, so matches streaming in as off-screen models build don't re-jump.
  // Tracked in state and adjusted during render (not an effect) so the nonce bump
  // doesn't cascade through an extra commit.
  const [autoScrolledQuery, setAutoScrolledQuery] = useState<string | null>(null);
  if (!findActive) {
    if (autoScrolledQuery !== null) setAutoScrolledQuery(null);
  } else if (matchCount > 0 && autoScrolledQuery !== query) {
    setAutoScrolledQuery(query);
    setNavNonce((n) => n + 1);
  }
  // Expand the active match's file (drop its collapse override) during render so
  // the scroll effect below finds the row mounted — mirrors the jump pattern,
  // keyed on the nonce so each navigation re-fires.
  const [prevNavNonce, setPrevNavNonce] = useState(0);
  if (navNonce !== prevNavNonce) {
    setPrevNavNonce(navNonce);
    if (activeMatch) setOverrides((o) => (o[activeMatch.file] === false ? o : { ...o, [activeMatch.file]: false }));
  }
  // Bring the active match into view: rough-scroll by its body offset, then
  // exact-center the row once it mounts (retry, like comment jump).
  useEffect(() => {
    if (!navNonce) return;
    const m = activeMatch;
    const pane = paneRef.current;
    if (!m || !pane) return;
    const i = files.findIndex((f) => f.path === m.file);
    if (i < 0) return;
    const rough = () => Math.max(0, Math.min(offsets[i] + HEADER_H + m.y - pane.clientHeight / 2, pane.scrollHeight - pane.clientHeight));
    let tries = 0;
    const center = () => {
      const row = pane.querySelector(`[data-file="${CSS.escape(m.file)}"] [data-row-index="${m.modelIndex}"]`) as HTMLElement | null;
      // Row already mounted (e.g. stepping between matches on the same line) →
      // center it directly. scrollIntoView is a no-op when it's already centered,
      // so there's no jolt. Only rough-scroll (by arithmetic) when the row isn't
      // in the window yet, then retry until it mounts. (#8)
      if (row) { row.scrollIntoView({ block: "center" }); return; }
      pane.scrollTop = rough();
      if (tries < 20) { tries += 1; findScrollTimer.current = window.setTimeout(center, 30); }
    };
    center();
    return () => clearTimeout(findScrollTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navNonce]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    setViewportH(pane.clientHeight);
    setViewportW(pane.clientWidth);
    let raf = 0;
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; setScrollTop(pane.scrollTop); }); };
    pane.addEventListener("scroll", onScroll, { passive: true });
    // Height drives the row window → commit immediately (it's unchanged while the
    // comments pane animates width, so that's a no-op re-render). Width only feeds
    // the per-file horizontal-overflow test, so DEBOUNCE it: a comments open/close
    // animates the pane width over ~200ms, and updating viewportW every frame would
    // re-render every on-screen file section. Rows reflow natively meanwhile;
    // commit width once the resize settles. (#pane-anim)
    let wTimer = 0;
    const ro = new ResizeObserver(() => {
      setViewportH(pane.clientHeight);
      if (wTimer) clearTimeout(wTimer);
      wTimer = window.setTimeout(() => setViewportW(pane.clientWidth), 160);
    });
    ro.observe(pane);
    return () => { pane.removeEventListener("scroll", onScroll); ro.disconnect(); if (raf) cancelAnimationFrame(raf); if (wTimer) clearTimeout(wTimer); };
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
    pane.scrollTop = Math.max(0, Math.min(offsets[i] - PAD, pane.scrollHeight - pane.clientHeight));
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
    const want = Math.max(0, Math.min(offsets[i] - PAD, pane.scrollHeight - pane.clientHeight));
    if (Math.abs(pane.scrollTop - want) > 1) pane.scrollTop = want;
  }, [offsets, total, files]);

  const lastVisible = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleFileChange) return;
    let current = files[0]?.path ?? null;
    for (let i = 0; i < files.length; i++) { if (offsets[i] - PAD <= scrollTop + 4) current = files[i].path; else break; }
    if (current && current !== lastVisible.current) { lastVisible.current = current; onVisibleFileChange(current); }
  }, [scrollTop, files, offsets, onVisibleFileChange]);

  const top0 = scrollTop - OVERSCAN, bot0 = scrollTop + viewportH + OVERSCAN;

  return (
    <div className="relative h-full">
      {findOpen && (
        <DiffFind
          query={query}
          onQueryChange={setQuery}
          count={matchCount}
          activeIndex={matchCount > 0 ? Math.min(activeIdx, matchCount - 1) : -1}
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          onPrev={() => stepMatch(-1)}
          onNext={() => stepMatch(1)}
          onToggleCaseSensitive={() => setCaseSensitive((v) => !v)}
          onToggleWholeWord={() => setWholeWord((v) => !v)}
          onClose={closeFind}
          inputRef={findInputRef}
        />
      )}
      {/* overflow-anchor:none — we anchor the scroll manually on collapse (#viewed-anchor). */}
      <div ref={paneRef} className="h-full overflow-auto [overflow-anchor:none]" data-testid="diff-pane">
      {/* diff-tailwindcss-wrapper + data-theme scope @git-diff-view's hljs token
          colors onto our rows; the gdv layer sits below `utilities`, so our layout wins. */}
      <div
        className="diff-tailwindcss-wrapper"
        data-theme={theme}
        style={{
          position: "relative",
          height: total,
          // Code metrics for the rows (font-size, line height) + the gutter/fold
          // sizes. rowH (JS, used for the windowing math) === --code-lh here.
          "--code-fs": `${codeSize}px`,
          "--code-lh": `${rowH}px`,
          "--gutter-fs": `${Math.max(9, codeSize - 2)}px`,
          "--fold-fs": `${Math.max(10, codeSize - 1)}px`,
        } as CSSProperties}
      >
        {/* Opaque cap over the canvas gap above a stuck file header: without it,
            diff rows scrolling up peek through the strip between the pane's top
            edge and the header (which sticks at top:PAD). Layered BETWEEN content
            and headers (z-[15]: above the rows/rails, below header z-20) so a header
            being pushed up by the next one slides cleanly over the cap to the top
            edge, instead of vanishing under it ~PAD px early. (#6) */}
        <div className="sticky top-0 z-[15] bg-background" style={{ height: PAD }} aria-hidden />
        {files.map((entry, i) => {
          const collapsed = collapsedFor(entry);
          const bh = collapsed ? 0 : (bodyHeights[entry.path] ?? estReserved(entry, rowH));
          const sectionTop = offsets[i], bodyTop = sectionTop + HEADER_H;
          const onScreen = viewportH > 0 && !collapsed && bodyTop + bh > top0 && bodyTop < bot0;
          const view: [number, number] | null = onScreen ? [Math.max(0, top0 - bodyTop), Math.max(0, bot0 - bodyTop)] : null;
          // Header is "solo" when its body has fully scrolled up under the stuck
          // header (nothing renders right below it) — round its bottom corners so
          // it doesn't read as a cut-off tab. (#6)
          const headerSolo = !collapsed && bh > 0 && scrollTop >= sectionTop + bh - PAD && scrollTop <= sectionTop + bh + HEADER_H;
          return (
            <div key={entry.path} style={{ position: "absolute", top: sectionTop, left: PAD, right: PAD }}>
              <VFileSection
                entry={entry} theme={theme} layout={layout} cache={cache}
                collapsed={collapsed} viewed={viewedFiles.has(entry.path)}
                headerSolo={headerSolo}
                repoPath={target.repoPath}
                onToggleCollapse={toggleCollapse} onToggleViewed={onToggleViewed}
                view={view} paneW={viewportW} rowH={rowH} chPx={chPx}
                query={findActive ? query : ""}
                caseSensitive={caseSensitive} wholeWord={wholeWord}
                activeMatch={activeMatch && activeMatch.file === entry.path ? { modelIndex: activeMatch.modelIndex, side: activeMatch.side, col: activeMatch.col } : null}
                onMatches={onMatches}
                forceModel={findActive}
                comments={view || findActive ? (commentsByFile.get(entry.path) ?? noComments) : noComments}
                onAddComment={onAddComment} onAddFileComment={onAddFileComment} onEditComment={onEditComment} onDeleteComment={onDeleteComment} onToggleResolvedComment={onToggleResolvedComment}
                reportBodyHeight={reportBodyHeight} registerRef={registerRef}
              />
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

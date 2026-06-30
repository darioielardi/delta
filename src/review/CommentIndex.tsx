import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageSquareDashed, X } from "lucide-react";
import { useResizableWidth, usePaneResize, PaneResizer, COMMENTS_PANE } from "../lib/resizablePane";
import type { Comment } from "../types";

// Split so the dir can truncate while the filename (last segment) + line range
// always stay visible. (#r4)
function locationParts(c: Comment): { dir: string; name: string; suffix: string } {
  const a = c.anchor;
  if (!a) return { dir: "", name: "—", suffix: "" };
  const slash = a.file.lastIndexOf("/");
  const dir = slash >= 0 ? a.file.slice(0, slash + 1) : "";
  const name = slash >= 0 ? a.file.slice(slash + 1) : a.file;
  const suffix = a.startLine == null
    ? "file"
    : a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return { dir, name, suffix };
}

export function CommentIndex({
  open, onOpenChange, comments, onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
}) {
  // Inset right panel — part of the layout, not an overlay. The <aside>'s width
  // animates 0↔20rem, so the diff pane makes room smoothly instead of snapping.
  // The jank this used to cause: animating width resizes the sibling diff pane
  // every frame, and a naive width observer there re-renders the whole virtualized
  // list each time. The diff pane now DEBOUNCES its width state (see
  // VirtualDiffPane's ResizeObserver), so during this transition the rows reflow
  // natively — cheap — with zero React re-renders; viewportW commits once it
  // settles. The content is pinned to the right edge and revealed by the widening
  // aside, so it reads as sliding in from the side. (#4)
  //
  // Content stays mounted through the close animation (via `render`) so it can
  // slide out before unmounting. Reduced-motion neutralizes the transition
  // app-wide, so open/close is then instant.
  // Resizable, persisted comments panel; the divider lives on its left edge (the
  // pane grows leftward). `resizing` suppresses the open/close width transition so
  // the edge tracks the pointer instead of easing behind it.
  const [commentsWidth, setCommentsWidth] = useResizableWidth(COMMENTS_PANE);
  const { resizing, separatorProps } = usePaneResize(COMMENTS_PANE, commentsWidth, setCommentsWidth, "left");

  const [render, setRender] = useState(open);
  // Mount immediately on open by adjusting state during render (no effect cascade);
  // the effect only DEFERS unmount until the close animation finishes.
  if (open && !render) setRender(true);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setRender(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  const visible = open || render;

  const anchored = comments
    .filter((c) => c.scope !== "general")
    .sort((a, b) => {
      const fa = a.anchor?.file ?? "", fb = b.anchor?.file ?? "";
      return fa === fb ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0) : fa.localeCompare(fb);
    });
  const staleCount = anchored.filter((c) => c.stale).length;

  return (
    <aside
      aria-hidden={!open}
      style={{ width: open ? commentsWidth : 0 }}
      className={`relative shrink-0 ${resizing ? "" : "transition-[width] duration-200 ease-out"}`}
    >
      {/* Clip only the sliding content — the resize divider (rendered after) sits in
          the gutter to the panel's left and must NOT be clipped by the aside. */}
      <div className="absolute inset-0 overflow-hidden">
      {visible && (
      // Floating layout (#pad): transparent panel, no borders, PAD inset; the comment
      // cards float on the canvas. Pinned to the right edge (absolute) so the widening
      // aside reveals it in place — the slide — and the fixed width keeps the content
      // from reflowing while the aside animates.
      <div data-testid="comment-index" style={{ width: commentsWidth }} className="absolute right-0 top-0 flex h-full min-h-0 flex-col pt-3.5">
      <div className="flex h-8 shrink-0 items-center gap-2 pl-0 pr-3.5 text-[12px]">
        <span className="text-[15px] font-semibold text-foreground">Comments</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-[12px] text-muted-foreground">{anchored.length}</span>
        {staleCount > 0 && (
          <span
            className="ml-auto flex items-center gap-1 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400"
            title={`${staleCount} stale comment${staleCount === 1 ? "" : "s"}`}
          >
            ⚠ {staleCount} stale
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          className={`${staleCount > 0 ? "" : "ml-auto "}size-6 rounded-md bg-foreground/[0.04] text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground`}
          aria-label="Close comments"
          onClick={() => onOpenChange(false)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto pl-0 pr-3.5 pb-3.5 pt-2">
        {anchored.length === 0 && (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl squircle bg-muted/60 text-muted-foreground/70">
              <MessageSquareDashed className="size-[22px]" strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-[13px] font-medium text-foreground">No comments yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/70">Hover a line in the diff to add one.</p>
          </div>
        )}
        {anchored.map((c) => (
          <button
            key={c.id}
            className={`group flex w-full min-w-0 shrink-0 flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-left text-[13px] shadow-xs hover:border-foreground/25 hover:bg-foreground/[0.04] dark:shadow-none${c.resolved ? " opacity-55" : ""}`}
            onClick={() => onJump(c)}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              {(() => {
                const { dir, name, suffix } = locationParts(c);
                return (
                  // The dir truncates first (shrink-[9999]); the filename falls back to
                  // truncating only when it alone overflows; the line range stays pinned.
                  <span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
                    {dir && <span className="min-w-0 shrink-[9999] truncate text-muted-foreground/55">{dir}</span>}
                    <span className="min-w-0 truncate text-foreground/80">{name}</span>
                    <span className="ml-1 shrink-0 text-muted-foreground/70">{suffix}</span>
                  </span>
                );
              })()}
              {c.stale && <span className="shrink-0 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">⚠ stale</span>}
              {c.resolved && <span className="shrink-0 rounded-md squircle bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">✓</span>}
            </span>
            {c.body.trim() === "" ? (
              <span className="italic text-muted-foreground/70">Empty note</span>
            ) : (
              <span className="line-clamp-2 w-full break-words text-foreground">{c.body}</span>
            )}
          </button>
        ))}
      </div>
      </div>
      )}
      </div>
      {open && <PaneResizer edge="left" label="Resize comments panel" resizing={resizing} separatorProps={separatorProps} />}
    </aside>
  );
}

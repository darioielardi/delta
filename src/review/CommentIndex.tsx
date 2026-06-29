import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
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
  // Inset right panel — part of the layout, not an overlay. The space is reserved
  // by SNAPPING the <aside> width 0↔20rem (no transition); only the inner panel
  // slides/fades in via translate+opacity. Animating width would resize the
  // sibling diff pane every frame, and its ResizeObserver re-renders the whole
  // virtualized list on each — that was the jank. translate/opacity is composited
  // (Tailwind v4 maps translate-x-* to the standalone `translate` property, which
  // is GPU-accelerated like transform), so the diff pane reflows exactly once per
  // toggle (when the width snaps). (#4)
  //
  // The inner wrapper stays mounted whenever the aside renders, so flipping its
  // class reliably fires the transition (a mount-then-flip needs rAF, which the
  // webview pauses while offscreen). Only the contents unmount, kept alive through
  // the close animation by `render`. Reduced-motion neutralizes the transition via
  // the app-wide media rule; the width snap is already instant.
  const [render, setRender] = useState(open);
  // Mount immediately on open by adjusting state during render (no effect cascade);
  // the effect below only DEFERS unmount + the width-snap-to-0 until the close
  // animation finishes, so the panel can slide out before the space collapses.
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
      className={`shrink-0 overflow-hidden ${visible ? "w-80" : "w-0"}`}
    >
      {/* Always-mounted animation target: slides + fades on open/close. The space
          is reserved by the aside's width, so this only animates composited props. */}
      <div
        className={`h-full w-80 transition-[translate,opacity] duration-200 ease-out ${open ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0"}`}
      >
      {visible && (
      // Floating layout (#pad): transparent panel, no borders, PAD inset; the
      // comment cards float on the canvas like the diff cards.
      <div data-testid="comment-index" className="flex h-full w-80 min-h-0 flex-col pt-3.5">
      <div className="flex h-7 shrink-0 items-center gap-2 pl-0 pr-3.5 text-[12px]">
        <span className="font-medium text-foreground">Comments</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-muted-foreground">{anchored.length}</span>
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
          <p className="py-8 text-center text-[13px] text-muted-foreground">No comments yet</p>
        )}
        {anchored.map((c) => (
          <button
            key={c.id}
            className="group flex w-full min-w-0 shrink-0 flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-left text-[13px] shadow-xs hover:border-foreground/25 hover:bg-foreground/[0.04] dark:shadow-none"
            onClick={() => onJump(c)}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              {(() => {
                const { dir, name, suffix } = locationParts(c);
                return (
                  <span className="flex min-w-0 flex-1 items-baseline">
                    {dir && <span className="min-w-0 truncate text-muted-foreground/55">{dir}</span>}
                    <span className="shrink-0 text-foreground/80">{name}</span>
                    <span className="ml-1 shrink-0 text-muted-foreground/70">{suffix}</span>
                  </span>
                );
              })()}
              {c.stale && <span className="shrink-0 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">⚠ stale</span>}
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
    </aside>
  );
}

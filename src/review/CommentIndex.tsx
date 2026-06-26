import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { Comment } from "../types";

function locationLabel(c: Comment): string {
  const a = c.anchor;
  if (!a) return "—";
  if (a.startLine == null) return `${a.file} · file`;
  const range = a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return `${a.file} · ${range}`;
}

export function CommentIndex({
  open, onOpenChange, comments, onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
}) {
  // Inset right panel — part of the layout, not an overlay. Rendering nothing
  // when closed keeps it out of the flex row entirely.
  if (!open) return null;

  const anchored = comments
    .filter((c) => c.scope !== "general")
    .sort((a, b) => {
      const fa = a.anchor?.file ?? "", fb = b.anchor?.file ?? "";
      return fa === fb ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0) : fa.localeCompare(fb);
    });

  return (
    <aside data-testid="comment-index" className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border/70 bg-muted/20">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]">
        <span className="font-medium text-foreground">Comments</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-muted-foreground">{anchored.length}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto size-6 text-muted-foreground hover:text-foreground"
          aria-label="Close comments"
          onClick={() => onOpenChange(false)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {anchored.length === 0 && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">No comments yet</p>
        )}
        {anchored.map((c) => (
          <button
            key={c.id}
            className="group flex w-full min-w-0 flex-col items-start gap-1 overflow-hidden rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 text-left text-[13px] transition-colors hover:border-border hover:bg-accent"
            onClick={() => onJump(c)}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">{locationLabel(c)}</span>
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
    </aside>
  );
}

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

function locationLabel(c: Comment): string {
  if (c.scope === "general") return "General";
  const a = c.anchor;
  if (!a) return "General";
  if (a.startLine == null) return `${a.file} · file`;
  const range = a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return `${a.file} · ${range}`;
}

export function CommentIndex({
  open, onOpenChange, comments, onJump, onAddGeneral,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
  onAddGeneral: (body: string) => void;
}) {
  const [addingGeneral, setAddingGeneral] = useState(false);
  const generals = comments.filter((c) => c.scope === "general");
  const anchored = comments
    .filter((c) => c.scope !== "general")
    .sort((a, b) => {
      const fa = a.anchor?.file ?? "", fb = b.anchor?.file ?? "";
      return fa === fb ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0) : fa.localeCompare(fb);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[72vh] gap-3 overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Comments ({comments.length})</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div>
            {addingGeneral ? (
              <CommentEditor
                onSubmit={(body) => { onAddGeneral(body); setAddingGeneral(false); }}
                onCancel={() => setAddingGeneral(false)}
              />
            ) : (
              <Button size="sm" variant="secondary" className="h-7 gap-1.5" onClick={() => setAddingGeneral(true)}>
                <Plus className="size-3.5" /> General note
              </Button>
            )}
          </div>
          {comments.length === 0 && (
            <p className="py-8 text-center text-[13px] text-muted-foreground">No comments yet</p>
          )}
          {[...generals, ...anchored].map((c) => (
            <button
              key={c.id}
              className="group flex flex-col items-start gap-1 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 text-left text-[13px] transition-colors hover:border-border hover:bg-accent"
              onClick={() => onJump(c)}
            >
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                {locationLabel(c)}
                {c.stale && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">⚠ stale</span>}
              </span>
              <span className="line-clamp-2 text-foreground">{c.body}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

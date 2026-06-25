import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
      <DialogContent className="max-h-[70vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Comments ({comments.length})</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          <div>
            {addingGeneral ? (
              <CommentEditor
                onSubmit={(body) => { onAddGeneral(body); setAddingGeneral(false); }}
                onCancel={() => setAddingGeneral(false)}
              />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAddingGeneral(true)}>+ General note</Button>
            )}
          </div>
          {[...generals, ...anchored].map((c) => (
            <button key={c.id} className="flex flex-col items-start gap-0.5 rounded border p-2 text-left hover:bg-muted" onClick={() => onJump(c)}>
              <span className="text-[11px] text-muted-foreground">
                {locationLabel(c)}{c.stale ? " · ⚠ stale" : ""}
              </span>
              <span className="line-clamp-2">{c.body}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

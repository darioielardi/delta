import { useState } from "react";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

export function CommentThread({
  comments,
  onEdit,
  onDelete,
  onToggleResolved,
}: {
  comments: Comment[];
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onToggleResolved: (id: string) => void;
}) {
  // The open editor, plus whether its comment was blank when it opened.
  // Cancelling a comment that opened blank and is still blank discards it — a
  // never-saved draft shouldn't leave an empty note behind. A comment that had
  // content when opened is never deleted on cancel (abandoning an edit is safe).
  const [editing, setEditing] = useState<{ id: string; wasBlank: boolean } | null>(null);
  const open = (c: Comment) => setEditing({ id: c.id, wasBlank: c.body.trim() === "" });
  const close = () => setEditing(null);

  // Auto-open the editor for a newly-appeared empty (draft) comment. Adjusted
  // during render — not in an effect — so the editor opens in the same commit
  // with no stale-UI flash. `seen` both guards against re-opening a comment the
  // user already closed and prevents a render loop.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  if (comments.some((c) => !seen.has(c.id))) {
    const draft = comments.find((c) => !seen.has(c.id) && c.body.trim() === "");
    setSeen(new Set(comments.map((c) => c.id)));
    if (draft) setEditing({ id: draft.id, wasBlank: true });
  }

  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/60 text-[13px] shadow-sm">
      {comments.map((c) =>
        editing?.id === c.id ? (
          <div key={c.id} data-comment-id={c.id} className="flex flex-col gap-1.5 px-3.5 py-3">
            <CommentEditor
              initialValue={c.body}
              onSubmit={(body) => {
                onEdit(c.id, body);
                close();
              }}
              onCancel={() => {
                // A never-saved draft (opened blank, still blank) is discarded.
                if (editing.wasBlank && c.body.trim() === "") onDelete(c.id);
                close();
              }}
              // No Delete on an unsaved new draft — Cancel discards it. (#r2)
              onDelete={editing.wasBlank ? undefined : () => {
                onDelete(c.id);
                close();
              }}
            />
          </div>
        ) : (
          <div key={c.id} data-comment-id={c.id} className={`group flex flex-col gap-1.5 px-3.5 py-3${c.resolved ? " opacity-55" : ""}`}>
            {c.stale && (
              <span className="flex w-fit items-center gap-1 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">⚠ stale</span>
            )}
            {c.resolved && (
              <span className="flex w-fit items-center gap-1 rounded-md squircle bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">✓ Resolved</span>
            )}
            {c.body.trim() === "" ? (
              <button
                className="self-start text-[13px] italic text-muted-foreground/70 transition-colors hover:text-foreground"
                onClick={() => open(c)}
              >
                Empty note — click to edit
              </button>
            ) : (
              <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-0 prose-pre:my-1.5 prose-pre:text-[12px] prose-code:text-[12px]">
                <Markdown>{c.body}</Markdown>
              </div>
            )}
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => onToggleResolved(c.id)}>{c.resolved ? "Reopen" : "Resolve"}</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => open(c)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(c.id)}>Delete</Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

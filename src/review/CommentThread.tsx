import { useState } from "react";
import Markdown from "react-markdown";
import { Check, Pencil, Trash2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// The 3px status rail color encodes the comment's state at a glance, replacing
// the old chunky pills: editing → primary, resolved → emerald, stale → amber,
// otherwise a quiet neutral.
function railClass(c: Comment, isEditing: boolean): string {
  if (isEditing) return "bg-primary";
  if (c.resolved) return "bg-emerald-500";
  if (c.stale) return "bg-amber-500";
  return "bg-muted-foreground/30";
}

const ICON_BTN = "size-7 text-muted-foreground hover:text-foreground";
const RESOLVE_BTN = "size-7 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400";
const DEL_BTN = "size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive";

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
  // The open editor, plus whether its comment was blank when it opened — a
  // never-saved draft (opened blank, still blank) is discarded on cancel.
  const [editing, setEditing] = useState<{ id: string; wasBlank: boolean } | null>(null);
  // The comment pending a delete confirmation (drives the single ConfirmDialog).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const open = (c: Comment) => setEditing({ id: c.id, wasBlank: c.body.trim() === "" });
  const close = () => setEditing(null);

  // Auto-open the editor for a newly-appeared empty (draft) comment. Adjusted
  // during render — not in an effect — so the editor opens in the same commit
  // with no stale-UI flash. `seen` guards against re-opening a closed comment
  // and prevents a render loop.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  if (comments.some((c) => !seen.has(c.id))) {
    const draft = comments.find((c) => !seen.has(c.id) && c.body.trim() === "");
    setSeen(new Set(comments.map((c) => c.id)));
    if (draft) setEditing({ id: draft.id, wasBlank: true });
  }

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {comments.map((c) => {
        const isEditing = editing?.id === c.id;
        const collapsed = c.resolved && !isEditing;
        return (
          <div
            key={c.id}
            data-comment-id={c.id}
            className={`group flex overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm${collapsed ? " opacity-70" : ""}`}
          >
            <div className={`w-[3px] shrink-0 ${railClass(c, isEditing)}`} />
            <div className="min-w-0 flex-1">
              {isEditing ? (
                <div className="px-4 py-3.5">
                  <CommentEditor
                    initialValue={c.body}
                    onSubmit={(body) => {
                      onEdit(c.id, body);
                      close();
                    }}
                    onCancel={() => {
                      // A never-saved draft (opened blank, still blank) is discarded.
                      if (editing?.wasBlank && c.body.trim() === "") onDelete(c.id);
                      close();
                    }}
                  />
                </div>
              ) : collapsed ? (
                <div className="flex items-center gap-2.5 px-4 py-2.5">
                  <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.body}>
                    {c.body.trim() === "" ? "Empty note" : c.body}
                  </span>
                  <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Reopen" title="Reopen" onClick={() => onToggleResolved(c.id)}>
                    <RotateCcw className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" title="Delete" onClick={() => setConfirmId(c.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="px-4 py-3.5">
                  <div className="mb-2.5 flex items-center gap-1.5">
                    {c.stale ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        <TriangleAlert className="size-3.5" /> stale
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/70">{relTime(c.createdAt)}</span>
                    )}
                    <div className="ml-auto flex items-center gap-0.5">
                      <Button variant="ghost" size="icon-xs" className={RESOLVE_BTN} aria-label="Resolve" title="Resolve" onClick={() => onToggleResolved(c.id)}>
                        <Check className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Edit" title="Edit" onClick={() => open(c)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" title="Delete" onClick={() => setConfirmId(c.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
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
                </div>
              )}
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={confirmId != null}
        title="Delete this comment?"
        message="This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmId) onDelete(confirmId);
          setConfirmId(null);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

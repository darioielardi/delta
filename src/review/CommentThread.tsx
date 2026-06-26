import { useState } from "react";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

export function CommentThread({
  comments,
  onEdit,
  onDelete,
}: {
  comments: Comment[];
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/60 text-[13px] shadow-sm">
      {comments.map((c) =>
        editingId === c.id ? (
          <div key={c.id} className="p-1">
            <CommentEditor
              initialValue={c.body}
              onSubmit={(body) => {
                onEdit(c.id, body);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          </div>
        ) : (
          <div key={c.id} className="group flex flex-col gap-1.5 px-3 py-2.5">
            {c.stale && (
              <span className="flex w-fit items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">⚠ stale</span>
            )}
            <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-0 prose-pre:my-1.5 prose-pre:text-[12px] prose-code:text-[12px]">
              <Markdown>{c.body}</Markdown>
            </div>
            <div className="-mb-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setEditingId(c.id)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive" onClick={() => onDelete(c.id)}>Delete</Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

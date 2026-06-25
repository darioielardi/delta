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
    <div className="flex flex-col divide-y rounded border bg-muted/30 text-xs">
      {comments.map((c) =>
        editingId === c.id ? (
          <CommentEditor
            key={c.id}
            initialValue={c.body}
            onSubmit={(body) => {
              onEdit(c.id, body);
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={c.id} className="flex flex-col gap-1 p-2">
            {c.stale && <span className="w-fit rounded bg-amber-500/20 px-1 text-[10px] text-amber-600">⚠ stale</span>}
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <Markdown>{c.body}</Markdown>
            </div>
            <div className="flex gap-2 text-muted-foreground">
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={() => setEditingId(c.id)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={() => onDelete(c.id)}>Delete</Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

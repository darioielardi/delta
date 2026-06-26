import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CommentEditor({
  initialValue = "",
  onSubmit,
  onCancel,
  onChange,
  onDelete,
  autoFocus = true,
}: {
  initialValue?: string;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  /** Fired on every keystroke so the host can persist edits live. */
  onChange?: (body: string) => void;
  /** When provided, renders a Delete action (used to discard a draft comment). */
  onDelete?: () => void;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  // Empty is allowed: a draft comment is persisted on open and may stay blank.
  const submit = () => onSubmit(value.trim());
  return (
    <div className="flex flex-col gap-2 p-1">
      <textarea
        autoFocus={autoFocus}
        className="min-h-[72px] resize-y rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed outline-none transition-[color,border-color] placeholder:text-muted-foreground/70 focus:border-ring"
        placeholder="Leave a comment (markdown)…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel?.();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7" onClick={submit}>Save</Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>Cancel</Button>
        )}
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
        <span className="ml-auto select-none text-[11px] text-muted-foreground/80">⌘↵ save · esc cancel</span>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow to fit the content so the editor is exactly as tall as the text it
  // holds. Entering edit mode then doesn't change the comment's height, and the
  // borderless, zero-padding textarea keeps the text in the same spot as the
  // rendered body — no visual shift between read and edit. (#5)
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(resize, []);
  // Start the caret at the END of existing text (not the start) when editing. (#r2)
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }, [autoFocus]);
  // Empty is allowed: a draft comment is persisted on open and may stay blank.
  const submit = () => onSubmit(value.trim());
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        rows={1}
        className="w-full resize-none overflow-hidden bg-transparent p-0 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        placeholder="Leave a comment (markdown)…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
          resize();
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
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" className="h-7 px-3 text-[12px]" onClick={submit}>Save</Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={onCancel}>Cancel</Button>
        )}
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-[12px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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

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
  // holds. scrollHeight measures content + padding but not the border, so add the
  // border back (the field is border-box) to avoid clipping the last line. (#11)
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const borderY = el.offsetHeight - el.clientHeight; // top + bottom border
    el.style.height = `${el.scrollHeight + borderY}px`;
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
        rows={3}
        className="min-h-[5.25rem] w-full resize-none overflow-hidden rounded-md border border-input bg-muted/40 px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring"
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
      <div className="mt-2.5 flex items-center gap-2">
        <span className="mr-auto select-none text-[11px] text-muted-foreground/70">Markdown supported</span>
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
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={onCancel}>
            Cancel <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px] leading-none">esc</kbd>
          </Button>
        )}
        <Button size="sm" className="h-7 gap-1.5 px-3 text-[12px]" onClick={submit}>
          Save <kbd className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 py-0.5 font-mono text-[10px] leading-none text-primary-foreground/90">⌘↵</kbd>
        </Button>
      </div>
    </div>
  );
}

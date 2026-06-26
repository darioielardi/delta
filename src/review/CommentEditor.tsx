import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CommentEditor({
  initialValue = "",
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initialValue?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const submit = () => {
    const body = value.trim();
    if (body) onSubmit(body);
  };
  return (
    <div className="flex flex-col gap-2 p-1">
      <textarea
        autoFocus={autoFocus}
        className="min-h-[72px] resize-y rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed outline-none transition-[color,box-shadow,border-color] placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
        placeholder="Leave a comment (markdown)…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7" onClick={submit}>Save</Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>Cancel</Button>
        <span className="ml-auto select-none text-[11px] text-muted-foreground/80">⌘↵ save · esc cancel</span>
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-1.5 p-2">
      <textarea
        autoFocus={autoFocus}
        className="min-h-16 resize-y rounded border bg-background p-2 text-xs font-mono"
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
      <div className="flex gap-2">
        <Button size="sm" onClick={submit}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

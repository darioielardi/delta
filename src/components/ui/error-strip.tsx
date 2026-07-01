// A dismissable error strip — the inline error banner used by the review and guide
// shells. Wrapping text + a × so a stuck error is never un-clearable. (#guide)
import { X } from "lucide-react";

export function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        title="Dismiss"
        className="grid size-4 shrink-0 place-items-center rounded text-destructive/70 transition-colors hover:bg-destructive/15 hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

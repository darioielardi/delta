// src/guide/WalkthroughDialog.tsx
//
// First-run confirmation before generating an AI walkthrough — centered + portaled
// (Return confirms, Esc cancels, bound on window so focus doesn't matter), mirroring
// ConfirmDialog. Non-destructive, so the primary action is the brand primary rather
// than the red destructive button. Shown once; the caller persists "don't ask again".
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";

export function WalkthroughDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 duration-100 data-[open]:animate-in data-[open]:fade-in-0"
      data-open
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Generate AI walkthrough"
        className="w-[22rem] max-w-[92vw] rounded-xl border border-border bg-popover p-5 shadow-2xl ring-1 ring-foreground/5 duration-150 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 dark:ring-foreground/10"
        data-open
      >
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="size-[18px]" />
        </div>
        <h2 className="mt-3 font-heading text-[15px] font-semibold leading-snug text-foreground">Generate AI walkthrough</h2>
        <p className="mt-1.5 text-[13px] leading-normal text-muted-foreground">
          Delta reads this diff with Claude and builds a guided walkthrough — change groups in reading order, with risk flags. This uses your Claude credits.
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 min-w-[4.5rem] rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sparkles className="size-3.5" /> Start walkthrough
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

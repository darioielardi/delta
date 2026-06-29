import { useEffect } from "react";
import { createPortal } from "react-dom";

// A macOS-style alert: title + message stacked at the top, actions bottom-right
// with the destructive default rightmost (Return confirms, Esc cancels — the
// platform convention, so no on-button key hints). Keyboard handling is bound on
// window so it works regardless of focus. Portaled to <body> because the card
// lives deep in the diff pane, whose transformed/virtualized ancestors would
// otherwise trap a fixed overlay.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
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
        aria-label={title}
        className="w-80 max-w-[92vw] rounded-xl border border-border/50 bg-popover/90 p-5 shadow-2xl backdrop-blur-xl duration-150 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95"
        data-open
      >
        <h2 className="text-[13px] font-semibold leading-snug text-foreground">{title}</h2>
        {message && <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{message}</p>}
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
            className="h-8 min-w-[4.5rem] rounded-lg bg-destructive px-3.5 text-[13px] font-medium text-white shadow-sm transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

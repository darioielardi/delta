import { useEffect } from "react";
import { createPortal } from "react-dom";

// A centered, non-destructive notice: title + message stacked at the top, a single
// "OK" action bottom-right (Return or Esc dismiss — no on-button key hint, matching
// the platform alert convention). The non-destructive sibling of ConfirmDialog;
// keyboard handling is bound on window so it works regardless of focus, and the card
// is portaled to <body> so virtualized/transformed ancestors can't trap the overlay.
export function NoticeDialog({
  open,
  title,
  message,
  dismissLabel = "OK",
  onClose,
}: {
  open: boolean;
  title: string;
  message?: string;
  dismissLabel?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 duration-100 data-[open]:animate-in data-[open]:fade-in-0"
      data-open
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-80 max-w-[92vw] rounded-xl border border-border bg-popover p-5 shadow-2xl ring-1 ring-foreground/5 duration-150 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 dark:ring-foreground/10"
        data-open
      >
        <h2 className="font-heading text-[15px] font-semibold leading-snug text-foreground">{title}</h2>
        {message && <p className="mt-1.5 text-[13px] leading-normal text-muted-foreground">{message}</p>}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="h-8 min-w-[4.5rem] rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

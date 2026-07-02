import { Download, Loader2, CheckCircle2, TriangleAlert } from "lucide-react";
import type { UpdaterStatus } from "./useUpdater";

export interface UpdateBannerProps {
  status: UpdaterStatus;
  version: string | null;
  progress: number | null;
  onDownload: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

// Button idioms mirror components/ui/button.tsx (default + ghost variants) so the
// banner's actions get the same hover + keyboard-focus affordances.
const primaryBtn =
  "shrink-0 rounded-md bg-primary px-3 py-1 text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/30";
const ghostBtn =
  "shrink-0 rounded-md px-3 py-1 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/30";

// Bottom-right toast for the update flow: it slides up when a new version is found
// (`available`), then updates in place through `downloading` → `ready` without
// re-animating. `idle`/`checking` are silent (the check runs in the background);
// `available`/`ready`/`error` carry a dismiss. (#updater-ui)
export function UpdateBanner({ status, version, progress, onDownload, onRestart, onDismiss }: UpdateBannerProps) {
  if (status === "idle" || status === "checking") return null;

  const shell =
    "fixed bottom-4 right-4 z-50 min-w-[280px] max-w-[380px] rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg animate-in slide-in-from-bottom-8 fade-in duration-300 ease-out";

  if (status === "available") {
    return (
      <output className={`${shell} flex items-center gap-3 border-border`}>
        <Download className="size-4 shrink-0 text-primary" />
        <span className="flex-1">New version available{version ? ` (v${version})` : ""}.</span>
        <button type="button" onClick={onDownload} className={primaryBtn}>
          Download
        </button>
        <button type="button" onClick={onDismiss} className={ghostBtn}>
          Later
        </button>
      </output>
    );
  }

  if (status === "downloading") {
    const pct = progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
    return (
      <output className={`${shell} border-border`}>
        <div className="flex items-center gap-2.5">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <span className="flex-1">Downloading update…</span>
          {pct != null && <span className="tabular-nums text-muted-foreground">{pct}%</span>}
        </div>
        <div className="relative mt-2 h-1 w-full overflow-hidden rounded-full bg-primary/15">
          {pct != null ? (
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary/70 [animation:delta-indeterminate_1.1s_ease-in-out_infinite]" />
          )}
        </div>
      </output>
    );
  }

  if (status === "error") {
    return (
      <output
        className={`${shell} flex items-center gap-2.5 border-amber-500/40 text-amber-600 dark:border-amber-400/40 dark:text-amber-400`}
      >
        <TriangleAlert className="size-4 shrink-0" />
        <span className="flex-1">Update failed.</span>
        <button type="button" onClick={onDismiss} className={ghostBtn}>
          Dismiss
        </button>
      </output>
    );
  }

  // ready
  return (
    <output className={`${shell} flex items-center gap-3 border-border`}>
      <CheckCircle2 className="size-4 shrink-0 text-primary" />
      <span className="flex-1">Update ready{version ? ` (v${version})` : ""}.</span>
      <button type="button" onClick={onRestart} className={primaryBtn}>
        Restart now
      </button>
      <button type="button" onClick={onDismiss} className={ghostBtn}>
        Later
      </button>
    </output>
  );
}

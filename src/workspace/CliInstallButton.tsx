// Header call-to-action that installs the `delta` CLI in one click, with a clear
// dismiss (✕). It hides itself when the CLI is already installed (cli_status) or
// once dismissed (persisted in localStorage, so it won't nag across windows). The
// install state machine lives in useCliInstall so the launcher empty-state promo
// shares the same status/dismiss/outcomes. (#cli)
import { Terminal, X, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useCliInstall } from "./useCliInstall";

export function CliInstallButton() {
  const { phase, detail, copied, install, dismiss, copyCommand } = useCliInstall();

  if (phase === "checking" || phase === "hidden") return null;

  const pill = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border text-[13px] shadow-sm transition-colors";

  if (phase === "working") {
    return (
      <span className={`${pill} border-primary/30 bg-primary/10 px-2.5 font-medium text-primary`}>
        <Loader2 className="size-3.5 animate-spin" /> Installing…
      </span>
    );
  }

  if (phase === "linked" || phase === "pathUpdated") {
    return (
      <span
        className={`${pill} animate-in fade-in zoom-in-95 duration-200 border-emerald-500/40 bg-emerald-500/15 px-2.5 font-medium text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/15 dark:text-emerald-300`}
        title={detail}
      >
        <CheckCircle2 className="size-4" />
        {phase === "pathUpdated" ? "Installed — open a new terminal" : "delta CLI installed"}
      </span>
    );
  }

  if (phase === "manual" || phase === "error") {
    return (
      <span
        className={`${pill} border-amber-500/40 bg-amber-500/10 pl-2.5 pr-1 text-amber-600 dark:border-amber-400/40 dark:text-amber-400`}
        title={detail}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        {phase === "manual" ? (
          <button type="button" onClick={copyCommand} className="font-medium underline-offset-2 transition-colors hover:underline">
            {copied ? "Copied — paste in a terminal" : "Copy install command"}
          </button>
        ) : (
          <span className="font-medium">Install failed</span>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="inline-flex size-5 items-center justify-center rounded transition-colors hover:bg-amber-500/20"
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  }

  // idle
  return (
    <span className={`${pill} border-primary/30 bg-primary/10 px-1 font-medium text-primary`}>
      <button
        type="button"
        onClick={install}
        title="Symlink the delta CLI onto your PATH so you can run `delta` from any terminal"
        className="inline-flex h-5 items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-primary/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Terminal className="size-3.5" /> Install CLI
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="inline-flex size-5 items-center justify-center rounded text-primary/60 transition-colors hover:bg-primary/20 hover:text-primary"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

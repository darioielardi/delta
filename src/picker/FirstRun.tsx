// The launcher's empty state: shown whenever there's nothing to list (no recent
// reviews and no known-repo worktrees) — not a one-time onboarding, just the
// "nothing to display yet" surface. Leads with one inviting action (open your
// first repo) and a quiet promo that explains why the CLI is worth installing.
// (#empty)
import { FolderOpen, ArrowRight, Terminal, X, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useCliInstall } from "@/workspace/useCliInstall";

export function FirstRun({ onOpenRepo }: { onOpenRepo: () => void }) {
  return (
    <div className="flex w-full flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Primary action — a full-width button-card. */}
      <button
        type="button"
        onClick={onOpenRepo}
        className="group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 text-left shadow-sm transition-[border-color,background-color,box-shadow] hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-md focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl squircle bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <FolderOpen className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold leading-tight text-foreground">Open a repository</span>
          <span className="text-[12.5px] leading-snug text-muted-foreground">Pick a git repo to review its changes.</span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground/50 transition-[translate,color] group-hover:translate-x-0.5 group-hover:text-primary" />
      </button>

      {/* Why-install-the-CLI promo (hides once installed or dismissed). */}
      <CliPromo />

      <p className="px-1 text-center text-[12px] text-muted-foreground/70">
        or press{" "}
        <kbd className="rounded border border-border/70 bg-background/60 px-1 py-0.5 text-[10px] font-medium leading-none">⌘O</kbd>{" "}
        to open a repository
      </p>
    </div>
  );
}

// Explains the payoff of installing the CLI — run `delta` from any worktree/branch
// to review an agent's work without coming back here — and carries the install
// action through its outcomes. Shares state with the header pill via useCliInstall.
function CliPromo() {
  const { phase, detail, copied, install, dismiss, copyCommand } = useCliInstall();
  if (phase === "checking" || phase === "hidden") return null;

  return (
    <div className="flex w-full items-center gap-3.5 rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-left">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg squircle bg-foreground/[0.05] text-muted-foreground">
        <Terminal className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-tight text-foreground">Review from your terminal</span>
        <span className="text-[12px] leading-snug text-muted-foreground">
          Install the CLI, then just run{" "}
          <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[11px] text-foreground/80">delta</code>{" "}
          in any worktree or branch to review your agent’s work.
        </span>
      </div>
      <CliAction phase={phase} detail={detail} copied={copied} install={install} dismiss={dismiss} copyCommand={copyCommand} />
    </div>
  );
}

// The phase-dependent control on the right of the promo. Kept narrow so the copy
// keeps the width; mirrors the header pill's outcomes in a card-sized form.
function CliAction({ phase, detail, copied, install, dismiss, copyCommand }: ReturnType<typeof useCliInstall>) {
  const dismissBtn = (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Dismiss"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      <X className="size-3.5" />
    </button>
  );

  if (phase === "working") {
    return (
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Installing…
      </span>
    );
  }

  if (phase === "linked" || phase === "pathUpdated") {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1 text-[12px] font-medium text-emerald-600 dark:text-emerald-400"
        title={detail}
      >
        <CheckCircle2 className="size-4" />
        {phase === "pathUpdated" ? "Open a new terminal" : "Installed"}
      </span>
    );
  }

  if (phase === "manual" || phase === "error") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-amber-600 dark:text-amber-400" title={detail}>
        <TriangleAlert className="size-3.5 shrink-0" />
        {phase === "manual" ? (
          <button type="button" onClick={copyCommand} className="font-medium underline-offset-2 transition-colors hover:underline">
            {copied ? "Copied" : "Copy command"}
          </button>
        ) : (
          <span className="font-medium">Failed</span>
        )}
        {dismissBtn}
      </span>
    );
  }

  // idle
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={install}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        Install
      </button>
      {dismissBtn}
    </span>
  );
}

// The launcher's empty state: shown whenever there's nothing to list (no recent
// reviews and no known-repo worktrees) — not a one-time onboarding, just the
// "nothing to display yet" surface. Leads with one inviting action (open your
// first repo) and offers the CLI install as a quiet secondary step. (#empty)
import { FolderOpen, ArrowRight } from "lucide-react";
import { CliInstallButton } from "@/workspace/CliInstallButton";

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

      {/* Quiet secondary row: keyboard hint on the left, CLI install on the right.
          CliInstallButton self-hides when the CLI is already installed or dismissed. */}
      <div className="flex min-h-7 items-center justify-between gap-3 px-1">
        <span className="text-[12px] text-muted-foreground/80">
          or press{" "}
          <kbd className="rounded border border-border/70 bg-background/60 px-1 py-0.5 text-[10px] font-medium leading-none">⌘O</kbd>
        </span>
        <CliInstallButton />
      </div>
    </div>
  );
}

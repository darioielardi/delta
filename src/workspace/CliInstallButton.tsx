// Header call-to-action that installs the `delta` CLI in one click, with a clear
// dismiss (✕). It hides itself when the CLI is already installed (cli_status) or
// once dismissed (persisted in localStorage, so it won't nag across windows).
// Install is one-shot: the backend symlinks `delta` onto PATH and, when it has to
// fall back to ~/.local/bin, wires that dir into the user's shell configs so new
// terminals pick it up with no manual step. (#cli)
import { useEffect, useState } from "react";
import { Terminal, X, Check, Loader2, TriangleAlert } from "lucide-react";
import { api } from "../api";

type Phase = "checking" | "idle" | "working" | "linked" | "pathUpdated" | "manual" | "error" | "hidden";

const DISMISS_KEY = "delta.cliPromptDismissed";

export function CliInstallButton() {
  // Dismissed is known synchronously, so seed it in the initializer rather than
  // via setState in the effect (which would cascade renders). "checking" means we
  // still need to ask the backend whether the CLI is already installed.
  const [phase, setPhase] = useState<Phase>(() =>
    localStorage.getItem(DISMISS_KEY) === "1" ? "hidden" : "checking",
  );
  // Carries the path / command / error text relevant to the current phase.
  const [detail, setDetail] = useState("");
  const [copied, setCopied] = useState(false);

  // Resolve "checking" → idle/hidden from cli_status. A failed check still offers
  // install (better to over-offer than hide it). setState happens only in the async
  // callbacks here, never synchronously in the effect body.
  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "1") return; // seeded hidden already
    let cancelled = false;
    void api
      .cliStatus()
      .then((s) => !cancelled && setPhase(s.installed ? "hidden" : "idle"))
      .catch(() => !cancelled && setPhase("idle"));
    return () => {
      cancelled = true;
    };
  }, []);

  // Success states are transient — they confirm, then get out of the way.
  useEffect(() => {
    if (phase !== "linked" && phase !== "pathUpdated") return;
    const t = setTimeout(() => setPhase("hidden"), phase === "pathUpdated" ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [phase]);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setPhase("hidden");
  }

  async function install() {
    setPhase("working");
    try {
      const out = await api.installCli();
      if (out.kind === "linked") {
        setDetail(out.path);
        setPhase("linked");
      } else if (out.kind === "linkedPathUpdated") {
        setDetail(out.path);
        setPhase("pathUpdated");
      } else {
        setDetail(out.command);
        setPhase("manual");
      }
    } catch (e) {
      setDetail(String(e));
      setPhase("error");
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command stays visible in the title */
    }
  }

  if (phase === "checking" || phase === "hidden") return null;

  const pill = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border text-[13px]";

  if (phase === "working") {
    return (
      <span className={`${pill} border-input bg-muted/40 px-2.5 text-muted-foreground`}>
        <Loader2 className="size-3.5 animate-spin" /> Installing…
      </span>
    );
  }

  if (phase === "linked" || phase === "pathUpdated") {
    return (
      <span
        className={`${pill} border-emerald-500/40 bg-emerald-500/10 px-2.5 text-emerald-600 dark:border-emerald-400/40 dark:text-emerald-400`}
        title={detail}
      >
        <Check className="size-3.5" />
        {phase === "pathUpdated" ? "Installed — open a new terminal" : "CLI installed"}
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
          <button type="button" onClick={copyCommand} className="font-medium underline-offset-2 hover:underline">
            {copied ? "Copied — paste in a terminal" : "Copy install command"}
          </button>
        ) : (
          <span className="font-medium">Install failed</span>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="inline-flex size-5 items-center justify-center rounded hover:bg-amber-500/20"
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  }

  // idle
  return (
    <span className={`${pill} border-input bg-muted/40 pl-2 pr-1 text-foreground`}>
      <button
        type="button"
        onClick={install}
        title="Symlink the delta CLI onto your PATH so you can run `delta` from any terminal"
        className="inline-flex items-center gap-1.5 rounded font-medium hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Terminal className="size-3.5 text-muted-foreground" /> Install CLI
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

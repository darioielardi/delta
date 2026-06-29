// Shared state machine for installing the `delta` CLI, so multiple surfaces (the
// review-header pill and the launcher empty-state promo) stay in sync — same
// status check, same dismiss, same install outcomes — instead of each keeping its
// own copy. Install is one-shot: the backend symlinks `delta` onto PATH and, when
// it has to fall back to ~/.local/bin, wires that dir into the user's shell configs
// so new terminals pick it up with no manual step. (#cli)
import { useEffect, useState } from "react";
import { api } from "../api";

export type CliPhase = "checking" | "idle" | "working" | "linked" | "pathUpdated" | "manual" | "error" | "hidden";

const DISMISS_KEY = "delta.cliPromptDismissed";

export interface CliInstall {
  phase: CliPhase;
  /** Path / command / error text relevant to the current phase. */
  detail: string;
  copied: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
  copyCommand: () => Promise<void>;
}

export function useCliInstall(): CliInstall {
  // Dismissed is known synchronously, so seed it in the initializer rather than via
  // setState in an effect. "checking" means we still need to ask the backend whether
  // the CLI is already installed.
  const [phase, setPhase] = useState<CliPhase>(() =>
    localStorage.getItem(DISMISS_KEY) === "1" ? "hidden" : "checking",
  );
  const [detail, setDetail] = useState("");
  const [copied, setCopied] = useState(false);

  // Resolve "checking" → idle/hidden from cli_status. A failed check still offers
  // install (better to over-offer than hide it).
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

  return { phase, detail, copied, install, dismiss, copyCommand };
}

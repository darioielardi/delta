import type { DiffMode, Target } from "./types";

export type Route =
  | { kind: "home" }
  | { kind: "review"; target: Target }
  | { kind: "guide"; target: Target };

const MODES: DiffMode[] = ["all-changes", "uncommitted", "last-commit", "branch-vs-base", "commit"];

export function resolveRoute(label: string | null, search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const isGuide = (label?.startsWith("guide-") ?? false) || view === "guide";
  const isReview = (label?.startsWith("review-") ?? false) || view === "review";
  if (!isGuide && !isReview) return { kind: "home" };

  const repoPath = params.get("repo") ?? "";
  const modeParam = params.get("mode");
  const mode = (MODES.includes(modeParam as DiffMode) ? modeParam : "all-changes") as DiffMode;
  const base = params.get("base") ?? undefined;
  const commit = params.get("commit") ?? undefined;
  const target: Target = { repoPath, mode, base, commit };
  return isGuide ? { kind: "guide", target } : { kind: "review", target };
}

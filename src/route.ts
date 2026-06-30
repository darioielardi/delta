import type { DiffMode, Target } from "./types";

export type Route = { kind: "home" } | { kind: "review"; target: Target };

const MODES: DiffMode[] = ["all-changes", "uncommitted", "last-commit", "branch-vs-base", "commit"];

export function resolveRoute(label: string | null, search: string): Route {
  const params = new URLSearchParams(search);
  const isReview = (label?.startsWith("review-") ?? false) || params.get("view") === "review";
  if (!isReview) return { kind: "home" };

  const repoPath = params.get("repo") ?? "";
  const modeParam = params.get("mode");
  const mode = (MODES.includes(modeParam as DiffMode) ? modeParam : "all-changes") as DiffMode;
  const base = params.get("base") ?? undefined;
  const commit = params.get("commit") ?? undefined;
  return { kind: "review", target: { repoPath, mode, base, commit } };
}

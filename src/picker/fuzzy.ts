import type { PickerWorktree, ReviewEntry } from "../types";

/** Subsequence fuzzy match. Returns a score (higher is better), or null if no match. */
export function fuzzyMatch(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const consecutive = ti === prev + 1 ? 2 : 0;
      const boundary = ti === 0 || /[/\s_.-]/.test(t[ti - 1]) ? 3 : 0;
      score += 1 + consecutive + boundary;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** Filter + rank reviews against a query (branch + repo name haystack). */
export function rankReviews(reviews: ReviewEntry[], query: string): ReviewEntry[] {
  const scored: { r: ReviewEntry; score: number }[] = [];
  for (const r of reviews) {
    const hay = `${r.target.worktree ?? ""} ${r.repoName}`;
    const score = fuzzyMatch(query, hay);
    if (score !== null) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || b.r.lastOpenedAt.localeCompare(a.r.lastOpenedAt));
  return scored.map((x) => x.r);
}

/** Filter + rank worktrees against a query (branch + repo name haystack). */
export function rankWorktrees(worktrees: PickerWorktree[], query: string): PickerWorktree[] {
  const scored: { w: PickerWorktree; score: number }[] = [];
  for (const w of worktrees) {
    const score = fuzzyMatch(query, `${w.branch} ${w.repoName}`);
    if (score !== null) scored.push({ w, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.w.lastCommitAt ?? "").localeCompare(a.w.lastCommitAt ?? ""));
  return scored.map((x) => x.w);
}

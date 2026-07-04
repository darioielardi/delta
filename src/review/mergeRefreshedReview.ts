import type { Review } from "../types";

/**
 * Merge a refreshed review session onto the review the user currently holds.
 *
 * A refresh recomputes diff-derived state: the file diff, re-anchored comment
 * positions, staleness, and the snapshot. Its comment *set*, though, was captured
 * when the session was computed — for the auto-refresh button, back when the fs
 * change was first detected. Swapping that in wholesale would drop any comment the
 * user added since (and clobber live body edits) — the diff-refresh data-loss bug.
 *
 * So take the refreshed review as the base for everything, but keep the *live*
 * comment set, overlaying only the re-anchored position + staleness the refresh
 * recomputed. Comments only in the refresh (deleted locally since) are not
 * resurrected; comments only in the live copy (added since) are preserved.
 */
export function mergeRefreshedReview(prev: Review, incoming: Review): Review {
  const refreshedById = new Map(incoming.comments.map((c) => [c.id, c]));
  const comments = prev.comments.map((c) => {
    const r = refreshedById.get(c.id);
    return r ? { ...c, anchor: r.anchor, stale: r.stale } : c;
  });
  return { ...incoming, comments };
}

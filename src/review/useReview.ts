import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Anchor, Comment, CommentScope, Review } from "../types";

const DEBOUNCE_MS = 400;

export function useReview(initial: Review | null) {
  const [review, setReview] = useState<Review | null>(initial);
  const latest = useRef<Review | null>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync the (rare) `initial` prop into state via a prev-prop guard during render
  // — not an effect — so there's no extra commit showing a stale review between.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) { setPrevInitial(initial); setReview(initial); }

  // Mirror the latest committed review into a ref so the stable save callbacks
  // read it without re-subscribing. Written post-commit here (ref writes belong
  // in effects, not render); `mutate` also writes it inline so an immediate
  // saveNow sees the freshest value before this effect runs.
  useEffect(() => { latest.current = review; }, [review]);

  // All actions are stable (useCallback over refs / stable setters) so consumers
  // that pass them down don't get new function identities every render — that
  // was forcing the whole diff pane to re-render on unrelated state changes.
  const saveNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current) void api.saveReview(latest.current);
  }, []);

  const saveDebounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (latest.current) void api.saveReview(latest.current);
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // save: "now"/"debounced" persist; "none" updates in-memory only (drafts that
  // must not hit disk until the user explicitly saves). (#r2)
  const mutate = useCallback((fn: (r: Review) => Review, save: "now" | "debounced" | "none") => {
    setReview((r) => {
      if (!r) return r;
      const next = fn(r);
      latest.current = next;
      return next;
    });
    if (save === "now") saveNow();
    else if (save === "debounced") saveDebounced();
  }, [saveNow, saveDebounced]);

  // A new comment starts as an in-memory draft (no disk write) — it only
  // persists when the editor is explicitly saved (updateCommentBody). Cancelling
  // a never-saved draft just deletes it from memory. (#r2)
  const addComment = useCallback((scope: CommentScope, anchor: Anchor | null, body: string) => {
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomUUID(),
      scope,
      anchor: anchor ?? null,
      body,
      stale: false,
      createdAt: now,
      updatedAt: now,
    };
    mutate((r) => ({ ...r, comments: [...r.comments, comment] }), body.trim() === "" ? "none" : "now");
    return comment.id;
  }, [mutate]);

  // Called only on an explicit Save now (no live keystroke updates), so persist
  // immediately rather than debounced. (#r2)
  const updateCommentBody = useCallback((id: string, body: string) => {
    const now = new Date().toISOString();
    mutate(
      (r) => ({ ...r, comments: r.comments.map((c) => (c.id === id ? { ...c, body, updatedAt: now } : c)) }),
      "now",
    );
  }, [mutate]);

  const deleteComment = useCallback((id: string) => {
    mutate((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== id) }), "now");
  }, [mutate]);

  const toggleViewed = useCallback((file: string, diffHash: string) => {
    mutate((r) => {
      const exists = r.viewed.some((v) => v.file === file);
      const viewed = exists ? r.viewed.filter((v) => v.file !== file) : [...r.viewed, { file, diffHash }];
      return { ...r, viewed };
    }, "now");
  }, [mutate]);

  return { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed };
}

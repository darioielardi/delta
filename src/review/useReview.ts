import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Anchor, Comment, CommentScope, Review } from "../types";

const DEBOUNCE_MS = 400;

export function useReview(initial: Review | null) {
  const [review, setReview] = useState<Review | null>(initial);
  const latest = useRef<Review | null>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = review;

  useEffect(() => setReview(initial), [initial]);

  function saveNow() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current) void api.saveReview(latest.current);
  }

  function saveDebounced() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (latest.current) void api.saveReview(latest.current);
    }, DEBOUNCE_MS);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function mutate(fn: (r: Review) => Review, save: "now" | "debounced") {
    setReview((r) => {
      if (!r) return r;
      const next = fn(r);
      latest.current = next;
      return next;
    });
    save === "now" ? saveNow() : saveDebounced();
  }

  function addComment(scope: CommentScope, anchor: Anchor | null, body: string) {
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
    mutate((r) => ({ ...r, comments: [...r.comments, comment] }), "now");
    return comment.id;
  }

  function updateCommentBody(id: string, body: string) {
    const now = new Date().toISOString();
    mutate(
      (r) => ({ ...r, comments: r.comments.map((c) => (c.id === id ? { ...c, body, updatedAt: now } : c)) }),
      "debounced",
    );
  }

  function deleteComment(id: string) {
    mutate((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== id) }), "now");
  }

  function toggleViewed(file: string, diffHash: string) {
    mutate((r) => {
      const exists = r.viewed.some((v) => v.file === file);
      const viewed = exists ? r.viewed.filter((v) => v.file !== file) : [...r.viewed, { file, diffHash }];
      return { ...r, viewed };
    }, "now");
  }

  return { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed };
}

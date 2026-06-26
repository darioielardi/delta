// src/diff/useFileDiffCache.ts
import { useEffect, useRef } from "react";
import { api } from "../api";
import type { FileDiff, Target } from "../types";

// Per-file diff store. Each FileSection subscribes to its OWN path, so a file
// finishing its async load re-renders only that section — not the whole pane.
// (Previously a single force() counter re-rendered every mounted diff on every
// load; on large reviews each load got slower as more mounted, starving the
// loader and causing visible pop-in on scroll.)
export interface FileDiffStore {
  get(path: string): FileDiff | undefined;
  load(path: string): Promise<void>;
  subscribe(path: string, cb: () => void): () => void;
  clear(): void;
}

interface InternalStore extends FileDiffStore {
  reset(target: Target | null): void;
}

function createStore(): InternalStore {
  const cache = new Map<string, FileDiff>();
  const inflight = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  let target: Target | null = null;

  const notify = (path: string) => listeners.get(path)?.forEach((cb) => cb());
  const notifyAll = () => listeners.forEach((set) => set.forEach((cb) => cb()));

  return {
    get: (path) => cache.get(path),
    subscribe(path, cb) {
      let set = listeners.get(path);
      if (!set) listeners.set(path, (set = new Set()));
      set.add(cb);
      return () => {
        const s = listeners.get(path);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) listeners.delete(path);
      };
    },
    async load(path) {
      if (!target || cache.has(path) || inflight.has(path)) return;
      inflight.add(path);
      try {
        const fd = await api.getFileDiff(target, path);
        cache.set(path, fd);
        notify(path); // wake only this path's subscriber
      } finally {
        inflight.delete(path);
      }
    },
    clear() {
      cache.clear();
      inflight.clear();
      notifyAll();
    },
    reset(t) {
      target = t;
      cache.clear();
      inflight.clear();
      notifyAll();
    },
  };
}

export function useFileDiffCache(target: Target | null): FileDiffStore {
  // The store lives for the lifetime of the pane; its identity is stable across
  // renders so it never invalidates a child's subscription.
  const storeRef = useRef<InternalStore | null>(null);
  if (storeRef.current === null) storeRef.current = createStore();
  const store = storeRef.current;

  // Re-point + clear when the target changes (new review / mode). Mirrors the
  // old clear-on-change, but notifies subscribers per-path instead of forcing a
  // global re-render. Loads are driven by IntersectionObserver callbacks that
  // fire asynchronously, well after this effect, so `target` is always set.
  useEffect(() => {
    store.reset(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, target?.repoPath, target?.worktree, target?.mode]);

  return store;
}

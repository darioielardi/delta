// src/diff/useFileDiffCache.ts
import { useEffect, useState } from "react";
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
  /** Drop + re-fetch specific files (changed on disk) — auto-refresh. (#9) */
  invalidate(paths: string[]): void;
  /** Drop + re-fetch every mounted file (base/HEAD shifted). (#9) */
  refreshAll(): void;
}

interface InternalStore extends FileDiffStore {
  reset(target: Target | null): void;
}

function createStore(): InternalStore {
  const cache = new Map<string, FileDiff>();
  const inflight = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  let target: Target | null = null;
  // Bumped every time the whole cache is dropped (target/base shifted). A load
  // started under an older generation must NOT write its result: the target it
  // fetched against is gone, so its diff is stale — and when the old target was a
  // single commit the file may not be in it at all ("not in diff" → blank). React
  // runs a section's load effect *before* the parent's reset effect, so the first
  // load after a mode switch fires against the previous target; the guard discards
  // it when it lands. (#stale)
  let generation = 0;

  const notify = (path: string) => listeners.get(path)?.forEach((cb) => cb());
  const notifyAll = () => listeners.forEach((set) => set.forEach((cb) => cb()));

  async function load(path: string) {
    if (!target || cache.has(path) || inflight.has(path)) return;
    const gen = generation;
    const t = target;
    inflight.add(path);
    try {
      const fd = await api.getFileDiff(t, path);
      if (gen !== generation) return; // store was reset mid-flight — drop the stale result
      cache.set(path, fd);
      notify(path); // wake only this path's subscriber
    } finally {
      if (gen === generation) inflight.delete(path); // a newer generation owns its own inflight entry
    }
  }

  // Drop these paths and immediately re-fetch any still mounted (have a
  // subscriber), so the section updates in place instead of getting stuck on a
  // stale/blank render. Off-screen ones just clear and reload lazily on scroll.
  function invalidate(paths: string[]) {
    for (const p of paths) {
      if (!cache.has(p) && !listeners.has(p)) continue;
      cache.delete(p);
      inflight.delete(p);
      notify(p);
      if (listeners.has(p)) void load(p);
    }
  }

  // Drop the whole cache (target or base shifted) and immediately re-fetch every
  // mounted file against the *current* target, so visible sections refill in place
  // instead of getting stuck blank. Bumping the generation discards any load still
  // in flight from the previous target. (#stale)
  function reload() {
    generation++;
    cache.clear();
    inflight.clear();
    notifyAll();
    for (const p of listeners.keys()) void load(p);
  }

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
    load,
    clear() {
      generation++;
      cache.clear();
      inflight.clear();
      notifyAll();
    },
    invalidate,
    refreshAll: reload,
    reset(t) {
      // Re-point first so the re-driven loads fetch against the new target. Unlike
      // the old clear-only reset, this re-fetches mounted files now: a section that
      // never left the viewport across a mode switch gets no IntersectionObserver
      // event, so without this it would keep its blank (or stale) body. (#stale)
      target = t;
      reload();
    },
  };
}

export function useFileDiffCache(target: Target | null): FileDiffStore {
  // The store lives for the lifetime of the pane; its identity is stable across
  // renders (the useState initializer runs once) so it never invalidates a
  // child's subscription. Lazy init avoids a ref read during render.
  const [store] = useState<InternalStore>(createStore);

  // Re-point + clear when the target changes (new review / mode). Notifies
  // subscribers per-path instead of forcing a global re-render, and re-fetches
  // every mounted file against the new target (a section that never leaves the
  // viewport across a mode switch gets no IntersectionObserver event, so it can't
  // rely on one to refill). Off-screen files still load lazily on scroll. (#stale)
  useEffect(() => {
    store.reset(target);
    // `commit` matters too: stepping commit→commit keeps mode === "commit", so without
    // it the store would keep the previous commit's target and fetch every new file
    // against the wrong diff (→ "file not in diff" → blank sections). (#commit-by-commit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, target?.repoPath, target?.worktree, target?.mode, target?.commit]);

  return store;
}

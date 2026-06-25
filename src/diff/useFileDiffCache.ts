// src/diff/useFileDiffCache.ts
import { useRef, useState } from "react";
import { api } from "../api";
import type { FileDiff, Target } from "../types";

export function useFileDiffCache(target: Target | null) {
  const cache = useRef<Map<string, FileDiff>>(new Map());
  const inflight = useRef<Set<string>>(new Set());
  const [, force] = useState(0);

  function get(path: string): FileDiff | undefined {
    return cache.current.get(path);
  }
  async function load(path: string) {
    if (!target || cache.current.has(path) || inflight.current.has(path)) return;
    inflight.current.add(path);
    try {
      const fd = await api.getFileDiff(target, path);
      cache.current.set(path, fd);
      force((n) => n + 1);
    } finally {
      inflight.current.delete(path);
    }
  }
  function clear() {
    cache.current.clear();
    inflight.current.clear();
    force((n) => n + 1);
  }
  return { get, load, clear };
}

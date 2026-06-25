// src/diff/useFileDiffCache.ts
import { useRef, useState } from "react";
import { api } from "../api";
import type { FileDiff, Target } from "../types";

export function useFileDiffCache(target: Target | null) {
  const cache = useRef<Map<string, FileDiff>>(new Map());
  const [, force] = useState(0);

  function get(path: string): FileDiff | undefined {
    return cache.current.get(path);
  }
  async function load(path: string) {
    if (!target || cache.current.has(path)) return;
    const fd = await api.getFileDiff(target, path);
    cache.current.set(path, fd);
    force((n) => n + 1);
  }
  function clear() {
    cache.current.clear();
    force((n) => n + 1);
  }
  return { get, load, clear };
}

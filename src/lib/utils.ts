import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** The worktree's directory name — the last path segment (e.g. "suspicious-cerf-2a36ea").
 *  For a repo's main worktree this equals the repo name. */
export function worktreeName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

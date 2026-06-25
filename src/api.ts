import { invoke } from "@tauri-apps/api/core";
import type { Target, DiffSummary, FileDiff } from "./types";

// Transport indirection: a dev-only fixture backend (VITE_MOCK_IPC) can replace
// the Tauri IPC so the frontend runs in a plain browser for behavioral checks.
// Production / `tauri dev` builds keep the real `invoke`; the dev path is gated
// by an env flag in main.tsx and tree-shaken out otherwise.
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn = invoke as InvokeFn;

/** Dev-only: swap the IPC transport. Used by src/dev/mockBackend.ts. */
export function __setInvokeForDev(fn: InvokeFn): void {
  invokeImpl = fn;
}

export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> =>
    invokeImpl("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> =>
    invokeImpl("get_file_diff", { target, path }),
};

import { invoke } from "@tauri-apps/api/core";
import type { Target, DiffSummary, FileDiff } from "./types";

export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> =>
    invoke("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> =>
    invoke("get_file_diff", { target, path }),
};

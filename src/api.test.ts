import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { api } from "./api";
import type { Target } from "./types";

describe("api", () => {
  beforeEach(() => invokeMock.mockReset());

  it("computeDiff calls the command with the target", async () => {
    const target: Target = { repoPath: "/r", mode: "all-changes" };
    invokeMock.mockResolvedValue({ files: [], baseLabel: "main", headLabel: "x" });
    const res = await api.computeDiff(target);
    expect(invokeMock).toHaveBeenCalledWith("compute_diff", { target });
    expect(res.baseLabel).toBe("main");
  });

  it("getFileDiff passes target and path", async () => {
    const target: Target = { repoPath: "/r", mode: "uncommitted" };
    invokeMock.mockResolvedValue({ status: "modified", binary: false });
    await api.getFileDiff(target, "a.ts");
    expect(invokeMock).toHaveBeenCalledWith("get_file_diff", { target, path: "a.ts" });
  });
});

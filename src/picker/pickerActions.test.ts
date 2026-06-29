import { describe, it, expect } from "vitest";
import { addRepo } from "./pickerActions";
import { __setInvokeForDev } from "../api";
import { onNotice, type Notice } from "../lib/notify";

describe("addRepo", () => {
  it("surfaces a notice when import_repo rejects (non-repo folder)", async () => {
    __setInvokeForDev(async (cmd: string) => {
      if (cmd === "import_repo") throw new Error("/x is not a git repository.");
      throw new Error(`unexpected ${cmd}`);
    });
    const notices: Notice[] = [];
    const off = onNotice((n) => notices.push(n));
    await addRepo();
    off();
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toMatch(/add repository/i);
    expect(notices[0].message).toMatch(/not a git repository/i);
  });

  it("opens the imported repo's main worktree on success, with no notice", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    __setInvokeForDev(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "import_repo") return { id: "i", root: "/r", name: "r", worktrees: [] } as never;
      if (cmd === "list_worktrees") return [{ path: "/r", branch: "main", isMain: true }] as never;
      if (cmd === "open_target") return undefined as never;
      throw new Error(`unexpected ${cmd}`);
    });
    const notices: Notice[] = [];
    const off = onNotice((n) => notices.push(n));
    await addRepo();
    off();
    expect(notices).toHaveLength(0);
    expect(calls.find(([c]) => c === "open_target")?.[1]).toEqual({ repoPath: "/r", mode: "all-changes", base: undefined });
  });
});

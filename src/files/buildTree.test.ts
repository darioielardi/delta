// src/files/buildTree.test.ts
import { describe, it, expect } from "vitest";
import { buildTree } from "./buildTree";
import type { FileEntry } from "../types";

const f = (path: string): FileEntry => ({ path, status: "modified", additions: 1, deletions: 0, binary: false });

describe("buildTree", () => {
  it("nests files under directory nodes", () => {
    const tree = buildTree([f("src/a.ts"), f("src/b/c.ts"), f("readme.md")]);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["readme.md", "src"]);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.kind).toBe("dir");
    expect(src.children.find((n) => n.name === "b")!.children[0].name).toBe("c.ts");
  });
});

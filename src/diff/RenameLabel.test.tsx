import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renameParts } from "./renameParts";
import { RenameLabel } from "./RenameLabel";

describe("renameParts", () => {
  it("collapses the new side to its basename for a same-directory rename", () => {
    expect(renameParts("src/auth/session.ts", "src/auth/token.ts")).toEqual({
      oldPath: "src/auth/session.ts",
      newDir: "src/auth/",
      newBase: "token.ts",
      sameDir: true,
    });
  });

  it("keeps the full new directory when the file also moves", () => {
    expect(renameParts("src/api/client.ts", "src/core/http.ts")).toEqual({
      oldPath: "src/api/client.ts",
      newDir: "src/core/",
      newBase: "http.ts",
      sameDir: false,
    });
  });

  it("treats two root-level files as the same directory", () => {
    expect(renameParts("a.ts", "b.ts")).toEqual({
      oldPath: "a.ts",
      newDir: "",
      newBase: "b.ts",
      sameDir: true,
    });
  });

  it("distinguishes a move to the root from a same-dir rename (empty newDir is not enough)", () => {
    expect(renameParts("src/a.ts", "b.ts")).toEqual({
      oldPath: "src/a.ts",
      newDir: "",
      newBase: "b.ts",
      sameDir: false,
    });
  });

  it("handles a move from the root into a subdirectory", () => {
    expect(renameParts("a.ts", "src/b.ts")).toEqual({
      oldPath: "a.ts",
      newDir: "src/",
      newBase: "b.ts",
      sameDir: false,
    });
  });
});

describe("RenameLabel", () => {
  it("shows the full old path and only the new basename for a same-directory rename", () => {
    render(<RenameLabel oldPath="src/auth/session.ts" newPath="src/auth/token.ts" />);
    expect(screen.getByTestId("rename-old").textContent).toBe("src/auth/session.ts");
    // New side collapses to the basename — the shared directory isn't repeated.
    expect(screen.getByTestId("rename-new").textContent).toBe("token.ts");
  });

  it("shows the full new path when the file also moves directory", () => {
    render(<RenameLabel oldPath="src/api/client.ts" newPath="src/core/http.ts" />);
    expect(screen.getByTestId("rename-old").textContent).toBe("src/api/client.ts");
    expect(screen.getByTestId("rename-new").textContent).toBe("src/core/http.ts");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { __setInvokeForDev } from "./api";

describe("App routing", () => {
  beforeEach(() => {
    __setInvokeForDev(async (cmd) => {
      if (cmd === "list_registry") return { version: 1, repos: [], reviews: [] } as never;
      if (cmd === "list_picker") return { recents: [], worktrees: [] } as never;
      return undefined as never;
    });
    window.history.replaceState({}, "", "/");
  });

  it("opens the home launcher without the command palette", async () => {
    render(<App />);
    expect(screen.getByTestId("home-root")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /add a repo/i })).toBeInTheDocument());
    // ⌘K palette is not auto-opened on the launch screen (#6).
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });
});

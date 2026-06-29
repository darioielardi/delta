import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FirstRun } from "./FirstRun";
import { __setInvokeForDev } from "../api";

describe("FirstRun", () => {
  beforeEach(() => {
    localStorage.clear();
    // CLI already installed → CliInstallButton self-hides, keeping the test focused
    // on the primary action.
    __setInvokeForDev(async (cmd: string) => {
      if (cmd === "cli_status") return { installed: true, path: "/usr/local/bin/delta" } as never;
      throw new Error(`unexpected ${cmd}`);
    });
  });

  it("shows the open-repository action and the ⌘O hint", () => {
    render(<FirstRun onOpenRepo={() => {}} />);
    expect(screen.getByText("Open a repository")).toBeInTheDocument();
    expect(screen.getByText("⌘O")).toBeInTheDocument();
  });

  it("invokes onOpenRepo when the action is clicked", () => {
    const onOpenRepo = vi.fn();
    render(<FirstRun onOpenRepo={onOpenRepo} />);
    fireEvent.click(screen.getByText("Open a repository"));
    expect(onOpenRepo).toHaveBeenCalledTimes(1);
  });

  it("offers the CLI install when it isn't installed yet", async () => {
    __setInvokeForDev(async (cmd: string) => {
      if (cmd === "cli_status") return { installed: false, path: null } as never;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<FirstRun onOpenRepo={() => {}} />);
    expect(await screen.findByRole("button", { name: /install cli/i })).toBeInTheDocument();
  });
});

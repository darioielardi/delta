import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FirstRun } from "./FirstRun";
import { __setInvokeForDev } from "../api";

function mockCli(installed: boolean) {
  __setInvokeForDev(async (cmd: string) => {
    if (cmd === "cli_status") return { installed, path: installed ? "/usr/local/bin/delta" : null } as never;
    if (cmd === "install_cli") return { kind: "linked", path: "/usr/local/bin/delta" } as never;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("FirstRun", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the open-repository action and the ⌘O hint", () => {
    mockCli(true); // CLI installed → promo hidden, keeps this test focused
    render(<FirstRun onOpenRepo={() => {}} />);
    expect(screen.getByText("Open a repository")).toBeInTheDocument();
    // The Kbd splits the shortcut into per-key spans, so match the kbd's text.
    expect(screen.getByText((_, el) => el?.tagName === "KBD" && el.textContent === "⌘O")).toBeInTheDocument();
  });

  it("invokes onOpenRepo when the action is clicked", () => {
    mockCli(true);
    const onOpenRepo = vi.fn();
    render(<FirstRun onOpenRepo={onOpenRepo} />);
    fireEvent.click(screen.getByText("Open a repository"));
    expect(onOpenRepo).toHaveBeenCalledTimes(1);
  });

  it("explains the CLI payoff and offers install when not installed", async () => {
    mockCli(false);
    render(<FirstRun onOpenRepo={() => {}} />);
    expect(await screen.findByText(/review your agent’s work/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();
  });

  it("hides the CLI promo once the CLI is installed", async () => {
    mockCli(true);
    render(<FirstRun onOpenRepo={() => {}} />);
    // Give the status check a tick to resolve, then confirm the promo never shows.
    await Promise.resolve();
    expect(screen.queryByText(/review from your terminal/i)).toBeNull();
  });
});

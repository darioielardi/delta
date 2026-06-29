// src/workspace/CliInstallButton.test.tsx — visibility, dismissal, install outcomes
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const cliStatus = vi.fn();
const installCli = vi.fn();
vi.mock("../api", () => ({
  api: {
    cliStatus: (...a: unknown[]) => cliStatus(...a),
    installCli: (...a: unknown[]) => installCli(...a),
  },
}));

import { CliInstallButton } from "./CliInstallButton";

describe("CliInstallButton", () => {
  beforeEach(() => {
    cliStatus.mockReset();
    installCli.mockReset();
    localStorage.clear();
  });

  it("offers install when the CLI isn't installed", async () => {
    cliStatus.mockResolvedValue({ installed: false, path: null });
    render(<CliInstallButton />);
    expect(await screen.findByRole("button", { name: /install cli/i })).toBeInTheDocument();
  });

  it("stays hidden when the CLI is already installed", async () => {
    cliStatus.mockResolvedValue({ installed: true, path: "/usr/local/bin/delta" });
    const { container } = render(<CliInstallButton />);
    await waitFor(() => expect(cliStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden (and skips the status check) once dismissed", async () => {
    localStorage.setItem("delta.cliPromptDismissed", "1");
    render(<CliInstallButton />);
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /install cli/i })).toBeNull();
    expect(cliStatus).not.toHaveBeenCalled();
  });

  it("confirms a clean install that's immediately on PATH", async () => {
    cliStatus.mockResolvedValue({ installed: false, path: null });
    installCli.mockResolvedValue({ kind: "linked", path: "/usr/local/bin/delta" });
    render(<CliInstallButton />);
    fireEvent.click(await screen.findByRole("button", { name: /install cli/i }));
    expect(await screen.findByText(/cli installed/i)).toBeInTheDocument();
  });

  it("tells the user to open a new terminal when it wired the shell config", async () => {
    cliStatus.mockResolvedValue({ installed: false, path: null });
    installCli.mockResolvedValue({ kind: "linkedPathUpdated", path: "/Users/me/.local/bin/delta", shells: ["zsh"] });
    render(<CliInstallButton />);
    fireEvent.click(await screen.findByRole("button", { name: /install cli/i }));
    expect(await screen.findByText(/open a new terminal/i)).toBeInTheDocument();
  });

  it("offers to copy the command when it can't auto-install", async () => {
    cliStatus.mockResolvedValue({ installed: false, path: null });
    installCli.mockResolvedValue({ kind: "manualNeeded", command: "sudo ln -sf x /usr/local/bin/delta", reason: "No writable dir." });
    render(<CliInstallButton />);
    fireEvent.click(await screen.findByRole("button", { name: /install cli/i }));
    expect(await screen.findByRole("button", { name: /copy install command/i })).toBeInTheDocument();
  });

  it("dismiss hides it and remembers the choice", async () => {
    cliStatus.mockResolvedValue({ installed: false, path: null });
    render(<CliInstallButton />);
    await screen.findByRole("button", { name: /install cli/i });
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("button", { name: /install cli/i })).toBeNull();
    expect(localStorage.getItem("delta.cliPromptDismissed")).toBe("1");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { __setInvokeForDev } from "./api";

describe("App routing", () => {
  beforeEach(() => {
    __setInvokeForDev(async (cmd) => {
      if (cmd === "list_registry") return { version: 1, repos: [], reviews: [] } as never;
      return undefined as never;
    });
    window.history.replaceState({}, "", "/");
  });

  it("opens the home window with the command palette up", async () => {
    render(<App />);
    expect(screen.getByTestId("home-root")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("command-palette")).toBeInTheDocument());
  });
});

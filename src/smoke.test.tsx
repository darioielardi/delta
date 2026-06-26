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

  it("renders the picker by default", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("picker-root")).toBeInTheDocument());
  });
});

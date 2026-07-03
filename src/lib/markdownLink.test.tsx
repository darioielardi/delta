import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Markdown from "react-markdown";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { markdownComponents } from "./markdownLink";

describe("markdown link handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens external links via the opener plugin in Tauri, preventing webview navigation", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    render(<Markdown components={markdownComponents}>{"[site](https://example.com)"}</Markdown>);
    // fireEvent.click returns false when a handler called preventDefault().
    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "site" }));
    expect(notPrevented).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("falls back to window.open outside Tauri (browser mock / tests)", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Markdown components={markdownComponents}>{"[mail](mailto:a@b.com)"}</Markdown>);
    fireEvent.click(screen.getByRole("link", { name: "mail" }));
    expect(open).toHaveBeenCalledWith("mailto:a@b.com", "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("never opens or navigates for relative / in-page anchor links", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Markdown components={markdownComponents}>{"[rel](./guide.md) [anchor](#sec)"}</Markdown>);
    const relPrevented = fireEvent.click(screen.getByRole("link", { name: "rel" }));
    const anchorPrevented = fireEvent.click(screen.getByRole("link", { name: "anchor" }));
    expect(relPrevented).toBe(false); // still no webview navigation
    expect(anchorPrevented).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

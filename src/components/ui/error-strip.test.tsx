import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorStrip } from "./error-strip";

describe("ErrorStrip", () => {
  it("renders the message and clears it on dismiss", () => {
    const onDismiss = vi.fn();
    render(<ErrorStrip message="something broke" onDismiss={onDismiss} />);
    expect(screen.getByText("something broke")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

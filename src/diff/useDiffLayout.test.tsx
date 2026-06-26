import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useDiffLayout } from "./useDiffLayout";

function Probe() {
  const [layout, setLayout] = useDiffLayout();
  return (
    <button data-testid="b" onClick={() => setLayout(layout === "unified" ? "split" : "unified")}>
      {layout}
    </button>
  );
}

beforeEach(() => localStorage.clear());

test("defaults to unified and persists the choice", () => {
  render(<Probe />);
  expect(screen.getByTestId("b").textContent).toBe("unified");
  act(() => screen.getByTestId("b").click());
  expect(screen.getByTestId("b").textContent).toBe("split");
  expect(localStorage.getItem("delta:diffLayout")).toBe("split");
});

test("reacts to a storage event from another window", () => {
  render(<Probe />);
  act(() => {
    localStorage.setItem("delta:diffLayout", "split");
    window.dispatchEvent(new StorageEvent("storage", { key: "delta:diffLayout", newValue: "split" }));
  });
  expect(screen.getByTestId("b").textContent).toBe("split");
});

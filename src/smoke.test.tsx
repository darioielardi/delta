import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import App from "./App";

it("renders the app root with the toolchain wired", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeInTheDocument();
});

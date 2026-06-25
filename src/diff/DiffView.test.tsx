import { render } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { FileDiff } from "../types";

// happy-dom does not implement canvas 2d context; stub it so git-diff-view's
// TextMeasure does not crash when it calls document.createElement("canvas").getContext("2d").
HTMLCanvasElement.prototype.getContext = () =>
  ({
    measureText: (text: string) => ({ width: text.length * 7 }),
    font: "",
  }) as unknown as CanvasRenderingContext2D;

const fd: FileDiff = {
  oldFileName: "a.ts", oldContent: "const x = 1\n", oldLang: "typescript",
  newFileName: "a.ts", newContent: "const x = 2\n", newLang: "typescript",
  status: "modified", binary: false,
};

it("DiffView renders modified file without crashing", () => {
  const { container } = render(<DiffView fileDiff={fd} mode="unified" />);
  expect(container.firstChild).toBeTruthy();
});

it("DiffView shows placeholder for binary", () => {
  const { getByText } = render(
    <DiffView fileDiff={{ ...fd, binary: true }} mode="unified" />
  );
  expect(getByText(/binary file/i)).toBeTruthy();
});

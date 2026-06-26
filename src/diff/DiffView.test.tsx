import { render } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { FileDiff } from "../types";

const fd: FileDiff = {
  oldFileName: "a.ts", oldContent: "const x = 1\n", oldLang: "typescript",
  newFileName: "a.ts", newContent: "const x = 2\n", newLang: "typescript",
  status: "modified", binary: false,
};

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  // happy-dom does not implement canvas 2d context; stub it so git-diff-view's
  // TextMeasure does not crash when it calls document.createElement("canvas").getContext("2d").
  HTMLCanvasElement.prototype.getContext = ((_contextId: string) =>
    ({
      measureText: (text: string) => ({ width: text.length * 7 }),
      font: "",
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

it("DiffView renders modified file without crashing", () => {
  const { container } = render(<DiffView fileDiff={fd} filePath="a.ts" layout="unified" />);
  expect(container.firstChild).toBeTruthy();
});

it("DiffView shows placeholder for binary", () => {
  const { getByText } = render(
    <DiffView fileDiff={{ ...fd, binary: true }} filePath="a.ts" layout="unified" />
  );
  expect(getByText(/binary file/i)).toBeTruthy();
});

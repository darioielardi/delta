// Scroll-anchoring math for collapsing a file in the diff pane (#viewed-anchor).
import { describe, it, expect } from "vitest";
import { anchorScrollTopOnCollapse } from "./anchorScroll";

// VirtualDiffPane's layout constants. A file whose header sits at document offset
// `headerTop` with a `bodyHeight`-tall body spans [headerTop, headerTop+HEADER_H+body].
const HEADER_H = 40;
const PAD = 14;
const anchor = (scrollTop: number, headerTop: number, body: number) =>
  anchorScrollTopOnCollapse(scrollTop, headerTop, body, HEADER_H, PAD);

describe("anchorScrollTopOnCollapse", () => {
  const headerTop = 1000;
  const body = 500; // body spans [1040, 1540]

  it("leaves scroll untouched when the file starts at or below the viewport top", () => {
    // File entirely below the fold (collapsing happens off-screen).
    expect(anchor(200, headerTop, body)).toBeNull();
    // Header exactly at the viewport top — body folds away beneath it, nothing above moves.
    expect(anchor(headerTop, headerTop, body)).toBeNull();
  });

  it("snaps the collapsed header to the top when you're reviewing the file", () => {
    // Viewport top sits inside the file (header sticky above) → header to top (offset - PAD).
    expect(anchor(1200, headerTop, body)).toBe(headerTop - PAD);
    // Boundary: viewport top at the very bottom of the body still counts as "on it".
    expect(anchor(1540, headerTop, body)).toBe(headerTop - PAD);
  });

  it("subtracts the removed body when the file is scrolled off above you", () => {
    // Reading a later file; the collapsing one is fully above the fold → keep view fixed.
    expect(anchor(2000, headerTop, body)).toBe(2000 - body);
    // Just past the body bottom is already the "behind you" case.
    expect(anchor(1541, headerTop, body)).toBe(1541 - body);
  });

  it("never returns a negative scroll position", () => {
    // First file (header at PAD) collapsed while reviewing it → clamps to 0, not -PAD.
    expect(anchor(50, PAD, 300)).toBe(0);
    // Removed body larger than the scroll offset.
    expect(anchor(20, 0, 1000)).toBe(0);
  });
});

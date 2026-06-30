// Scroll-anchoring math for collapsing a file in the diff pane (#viewed-anchor).
// Pure geometry, kept out of VirtualDiffPane.tsx so that file exports only its
// component (Fast Refresh preserves state for component-only modules).

// When a file collapses (its body height drops to 0), keep the view from jumping.
// `scrollTop` is the live position, `headerTop` the collapsing file's section offset
// (invariant under its own collapse), `bodyHeight` the body being removed; `headerH`
// and `pad` are the pane's layout constants. Returns the scrollTop to set, or null to
// leave it alone. Three cases by where the viewport top sits relative to the file:
//   • at/above the header → null: the collapse happens at or below the top edge, so
//     nothing above the fold moves; the body folds away under the header naturally.
//   • inside the file (you're reviewing it; its header is sticky at the top) → snap
//     the now-collapsed header to the top so it stays visible with the next file
//     beneath, instead of vanishing.
//   • past the file (you're reading a later one, this is scrolled off above) →
//     subtract the removed body so the content you're looking at stays put.
export function anchorScrollTopOnCollapse(
  scrollTop: number,
  headerTop: number,
  bodyHeight: number,
  headerH: number,
  pad: number,
): number | null {
  if (scrollTop <= headerTop) return null;
  const bodyBottom = headerTop + headerH + bodyHeight;
  if (scrollTop <= bodyBottom) return Math.max(0, headerTop - pad);
  return Math.max(0, scrollTop - bodyHeight);
}

// src/diff/wrap.ts
//
// Per-file line-wrapping helpers for the virtual diff renderer. Kept pure so the
// row-height arithmetic is testable outside the big component.
//
// Wrap mode is tight character packing (CSS `word-break: break-all`): every visual
// line fills to exactly `floor(textWidth / charWidth)` chars, so a wrapped row's
// height is EXACT — `ceil(cols / paneCols)` visual lines — and the virtualizer can
// compute row offsets without mounting rows. (Plain `overflow-wrap: anywhere` would
// break at whitespace first and render MORE lines than this predicts; `paneCols`
// must be derived from the real measured char advance for the count to match.)

// Extensions that wrap by default: prose + plain text, which read far better
// wrapped and rarely have alignment-significant columns. Code and structured/data
// files default OFF; the per-file toggle overrides either way.
export const WRAP_DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc",
]);

/** Whether a path wraps by default, from its extension (case-insensitive). */
export function wrapsByDefault(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // extensionless, or a dotfile with no real extension
  return WRAP_DEFAULT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Mono columns that fit in `width` px at `chPx` per char. 0 = unknown/invalid. */
export function paneColsFor(width: number, chPx: number): number {
  if (width <= 0 || chPx <= 0) return 0;
  return Math.max(1, Math.floor(width / chPx));
}

/** Visual (wrapped) line count for a line of `cols` chars at `paneCols` wide.
 *  Always >= 1. `paneCols <= 0` (unknown width) → 1, i.e. treat as not-yet-wrapped. */
export function visualLinesForCols(cols: number, paneCols: number): number {
  if (paneCols <= 0 || cols <= paneCols) return 1;
  return Math.ceil(cols / paneCols);
}

/** Cumulative top offset (px) of each row, plus a trailing total. Length is
 *  `rowLines.length + 1`: `tops[v]` is row v's top; `tops[rowLines.length]` is the
 *  total code height. Generalizes the old `v * rowH` when every entry is 1. */
export function buildRowOffsets(rowLines: readonly number[], rowH: number): number[] {
  const tops = new Array<number>(rowLines.length + 1);
  let acc = 0;
  for (let v = 0; v < rowLines.length; v++) { tops[v] = acc; acc += rowLines[v] * rowH; }
  tops[rowLines.length] = acc;
  return tops;
}

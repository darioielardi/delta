// Resolve a highlight.js language hint from a file path.
//
// We hand the file's extension (or, for extension-less files like Dockerfile /
// Makefile, its bare name) straight to @git-diff-view's lowlight highlighter,
// which resolves it through highlight.js's own alias registry — js, ts, tsx, py,
// rb, go, rs, css, scss, c, cpp, cs, php, sql, and ~50 more, far broader than a
// hand-maintained table. An unrecognized hint falls back to the library's
// auto-detection. This is why delta no longer ships an extension→language map.
export function langFromFilename(name: string | null | undefined): string {
  if (!name) return "";
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(dot + 1) : base).toLowerCase();
}

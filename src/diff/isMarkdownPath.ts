// Which files get the rendered "Preview" toggle in the diff pane. Markdown only —
// .mdx is deliberately excluded because react-markdown renders its JSX as broken
// text, which is worse than showing the diff.
const MARKDOWN_EXT = /\.(md|markdown)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.test(path);
}

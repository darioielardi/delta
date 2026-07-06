// Shared file glyph + status color, used by both the file tree/list (FilesPanel)
// and the AI-guidance panel so a file looks identical wherever it's listed.
import { FileCode, FileJson, FileText } from "lucide-react";
import type { FileStatus } from "../types";

export const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-emerald-500",
  modified: "text-amber-500",
  deleted: "text-rose-500",
  renamed: "text-sky-500",
};

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "rb", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp", "css", "scss", "html", "vue", "svelte", "sh", "toml", "yml", "yaml",
]);

export function FileGlyph({ name, status }: { name: string; status: FileStatus }) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const Icon = ext === "json" ? FileJson : CODE_EXT.has(ext) ? FileCode : FileText;
  // Icon colored by git status — one glyph carries both file type and change kind.
  return <Icon className={`size-3.5 shrink-0 ${STATUS_COLOR[status]}`} />;
}

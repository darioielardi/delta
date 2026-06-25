import { generateDiffFile } from "@git-diff-view/file";
import type { FileDiff } from "../types";

export function toDiffFile(fd: FileDiff) {
  const file = generateDiffFile(
    fd.oldFileName ?? "",
    fd.oldContent ?? "",
    fd.newFileName ?? "",
    fd.newContent ?? "",
    fd.oldLang ?? "",
    fd.newLang ?? ""
  );
  file.init();
  return file;
}

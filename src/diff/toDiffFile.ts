import { generateDiffFile } from "@git-diff-view/file";
import type { FileDiff } from "../types";
import { langFromFilename } from "./lang";

export function toDiffFile(fd: FileDiff) {
  const oldName = fd.oldFileName ?? "";
  const newName = fd.newFileName ?? "";
  const file = generateDiffFile(
    oldName,
    fd.oldContent ?? "",
    newName,
    fd.newContent ?? "",
    langFromFilename(oldName),
    langFromFilename(newName)
  );
  file.init();
  return file;
}

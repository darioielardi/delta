// Pure path-splitting logic for the rename header, kept in its own module (not in the
// component file) so Fast Refresh can preserve component state, and named distinctly
// from RenameLabel so the two don't collide on a case-insensitive filesystem. (#rename)

// Pieces the rename header needs. A same-dir rename shows only the new basename; a
// move shows the full new path. `sameDir` is explicit because an empty `newDir` alone
// can't tell a same-directory rename from a move to the repo root.
export interface RenameParts {
  oldPath: string;
  newDir: string; // new path's directory incl. trailing slash ("" at repo root)
  newBase: string; // new path's basename
  sameDir: boolean; // old and new live in the same directory
}

// Split a path into (dir-with-trailing-slash, basename), matching the header's own
// `entry.path` split so styling lines up (dir muted, base bold).
function splitPath(p: string): { dir: string; base: string } {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? { dir: p.slice(0, slash + 1), base: p.slice(slash + 1) } : { dir: "", base: p };
}

export function renameParts(oldPath: string, newPath: string): RenameParts {
  const oldDir = splitPath(oldPath).dir;
  const { dir: newDir, base: newBase } = splitPath(newPath);
  return { oldPath, newDir, newBase, sameDir: oldDir === newDir };
}

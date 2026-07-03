import { renameParts } from "./renameParts";

// Header label for a renamed file: `old/path → new`. The old path is the flexible,
// left-truncating span; the arrow and new name are shrink-0, so overflow eats the
// source, never the destination. Same-dir renames collapse the new side to its
// basename; a move shows the full new path (dir muted, base bold). (#rename)
export function RenameLabel({ oldPath, newPath, className = "" }: { oldPath: string; newPath: string; className?: string }) {
  const { newDir, newBase, sameDir } = renameParts(oldPath, newPath);
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      <span data-testid="rename-old" className="min-w-0 truncate text-muted-foreground" title={oldPath}>
        {oldPath}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground">→</span>
      <span data-testid="rename-new" className="shrink-0 truncate">
        {!sameDir && <span className="text-muted-foreground">{newDir}</span>}
        <span className="font-medium text-foreground">{newBase}</span>
      </span>
    </span>
  );
}

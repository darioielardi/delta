import { api } from "../api";

/**
 * Open the folder picker to import a repo, then open its main worktree for review.
 * Shared by the picker's "Add repo" button (Home + ⌘K) and the global ⌘O shortcut.
 */
export async function addRepo(): Promise<void> {
  const repo = await api.importRepo();
  if (!repo) return;
  const wts = await api.listWorktrees(repo.root);
  const main = wts.find((w) => w.isMain) ?? wts[0];
  if (main) void api.openTarget(main.path, "all-changes");
}

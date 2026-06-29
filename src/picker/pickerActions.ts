import { api } from "../api";
import { notify } from "../lib/notify";

/**
 * Open the folder picker to import a repo, then open its main worktree for review.
 * Shared by the picker's "Add repo" button (Home + ⌘K) and the global ⌘O shortcut.
 *
 * Picking a folder that isn't a git repo (the dominant failure) rejects in
 * `import_repo` with a clean message — surface it in a modal rather than failing
 * silently. (#add-repo-nonrepo)
 */
export async function addRepo(): Promise<void> {
  try {
    const repo = await api.importRepo();
    if (!repo) return;
    const wts = await api.listWorktrees(repo.root);
    const main = wts.find((w) => w.isMain) ?? wts[0];
    if (main) void api.openTarget(main.path, "all-changes");
  } catch (e) {
    // Tauri rejects a command's Err(String) with the bare string; tests/mocks may
    // throw an Error. Unwrap both to the clean message (no "Error:" prefix).
    notify({ title: "Can’t add repository", message: e instanceof Error ? e.message : String(e) });
  }
}

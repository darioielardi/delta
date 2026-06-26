use crate::git::{open_repo, resolve_base, resolve_worktree};
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use sha2::{Digest, Sha256};

/// All checked-out worktrees of the repo: the main workdir + any linked worktrees.
pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let repo = open_repo(repo_path)?;
    let mut out = Vec::new();
    if let Some(wd) = repo.workdir() {
        out.push(WorktreeEntry {
            path: wd.display().to_string(),
            branch: resolve_worktree(&repo)?,
            is_main: true,
        });
    }
    let names = repo.worktrees().map_err(|e| format!("list worktrees: {e}"))?;
    for name in names.iter().flatten() {
        let wt = match repo.find_worktree(name) {
            Ok(wt) => wt,
            Err(_) => continue,
        };
        let wt_path = wt.path();
        if let Ok(wt_repo) = git2::Repository::open(wt_path) {
            let branch = resolve_worktree(&wt_repo).unwrap_or_else(|_| "(detached)".into());
            out.push(WorktreeEntry { path: wt_path.display().to_string(), branch, is_main: false });
        }
    }
    Ok(out)
}

/// The shared `.git` directory for a repo and all its linked worktrees.
/// git2 0.19 has no `commondir()`, so derive it from `path()`:
/// main worktree → `<root>/.git`; linked worktree → `<root>/.git/worktrees/<name>`
/// (strip at the `worktrees` segment). Canonicalized so both forms match.
fn common_git_dir(repo: &git2::Repository) -> std::path::PathBuf {
    let p = repo.path();
    let base = match p.iter().position(|c| c == std::ffi::OsStr::new("worktrees")) {
        Some(pos) => p.iter().take(pos).collect::<std::path::PathBuf>(),
        None => p.to_path_buf(),
    };
    std::fs::canonicalize(&base).unwrap_or(base)
}

/// Registry repo entry: keyed by the git commondir so linked worktrees group together.
pub fn repo_entry(repo_path: &str) -> Result<RepoEntry, String> {
    let repo = open_repo(repo_path)?;
    let commondir = common_git_dir(&repo).display().to_string();
    let mut h = Sha256::new();
    h.update(commondir.as_bytes());
    let id: String = h.finalize()[..8].iter().map(|b| format!("{:02x}", b)).collect();
    let root = repo
        .workdir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo_path.to_string());
    let name = repo_name_from_path(&root);
    let default_branch = resolve_base(&repo, None).ok().map(|(label, _)| label);
    let worktrees = list_worktrees(repo_path)?;
    Ok(RepoEntry { id, root, name, default_branch, worktrees })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn list_worktrees_returns_main_only_for_simple_repo() {
        let (dir, _repo) = repo_with_commit();
        let wts = list_worktrees(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch, "main");
    }

    #[test]
    fn list_worktrees_includes_linked_worktrees() {
        let (dir, repo) = repo_with_commit();
        add_worktree(&repo, dir.path(), "delta-feat", "feat/auth");
        let mut wts = list_worktrees(dir.path().to_str().unwrap()).unwrap();
        wts.sort_by(|a, b| a.branch.cmp(&b.branch));
        let branches: Vec<&str> = wts.iter().map(|w| w.branch.as_str()).collect();
        assert!(branches.contains(&"main"));
        assert!(branches.contains(&"feat/auth"));
        assert_eq!(wts.iter().filter(|w| w.is_main).count(), 1);
    }

    #[test]
    fn repo_entry_has_name_default_branch_and_worktrees() {
        let (dir, _repo) = repo_with_commit();
        let entry = repo_entry(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entry.default_branch.as_deref(), Some("main"));
        assert!(!entry.id.is_empty());
        assert!(!entry.worktrees.is_empty());
    }
}

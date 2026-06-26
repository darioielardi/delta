use crate::git::model::DiffMode;
use crate::git::{open_repo, resolve_base, resolve_worktree};
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub repo_path: PathBuf,
    pub mode: DiffMode,
}

/// Pure CLI parsing. `args` excludes the binary name. No filesystem access.
pub fn parse_launch(args: &[String], cwd: &Path) -> Launch {
    let mut mode = DiffMode::AllChanges;
    let mut path_token: Option<&str> = None;
    for arg in args {
        match arg.as_str() {
            "--uncommitted" => mode = DiffMode::Uncommitted,
            "--last-commit" => mode = DiffMode::LastCommit,
            "--branch" => mode = DiffMode::BranchVsBase,
            other if !other.starts_with("--") && path_token.is_none() => path_token = Some(other),
            _ => {}
        }
    }
    let repo_path = match path_token {
        None | Some(".") => cwd.to_path_buf(),
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => cwd.join(p),
    };
    Launch { repo_path, mode }
}

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

    #[test]
    fn parse_launch_no_args_uses_cwd_all_changes() {
        let l = parse_launch(&[], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
        assert_eq!(l.mode, DiffMode::AllChanges);
    }

    #[test]
    fn parse_launch_dot_is_cwd() {
        let l = parse_launch(&[".".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
    }

    #[test]
    fn parse_launch_absolute_path_wins() {
        let l = parse_launch(&["/abs/repo".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
    }

    #[test]
    fn parse_launch_relative_path_joins_cwd() {
        let l = parse_launch(&["sub/dir".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj/sub/dir"));
    }

    #[test]
    fn parse_launch_mode_flags() {
        assert_eq!(parse_launch(&["--uncommitted".into()], Path::new("/c")).mode, DiffMode::Uncommitted);
        assert_eq!(parse_launch(&["--last-commit".into()], Path::new("/c")).mode, DiffMode::LastCommit);
        assert_eq!(parse_launch(&["--branch".into()], Path::new("/c")).mode, DiffMode::BranchVsBase);
    }

    #[test]
    fn parse_launch_flag_then_path() {
        let l = parse_launch(&["--uncommitted".into(), "/abs/repo".into()], Path::new("/c"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
        assert_eq!(l.mode, DiffMode::Uncommitted);
    }
}

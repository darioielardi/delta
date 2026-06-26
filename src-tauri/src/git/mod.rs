pub mod diff;
pub mod lang;
pub mod model;

use git2::{Oid, Repository, Tree};
use model::{DiffMode, Target};

pub type GitError = String;

pub enum RightSide {
    Tree(Oid),
    WorkTree,
}

pub struct Endpoints {
    pub from_tree: Option<Oid>,
    pub right: RightSide,
    pub base_label: String,
    pub head_label: String,
}

pub fn open_repo(repo_path: &str) -> Result<Repository, GitError> {
    Repository::discover(repo_path).map_err(|e| format!("open repo: {e}"))
}

fn tree_of<'r>(repo: &'r Repository, oid: Oid) -> Result<Tree<'r>, GitError> {
    repo.find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| format!("tree: {e}"))
}

/// Resolve the base branch to (label, commit oid). Tries origin/HEAD, then main, then master.
pub fn resolve_base(repo: &Repository, base: Option<&str>) -> Result<(String, Oid), GitError> {
    let candidates: Vec<String> = match base {
        Some(b) => vec![b.to_string()],
        None => vec!["origin/HEAD".into(), "main".into(), "master".into()],
    };
    let explicit = base.is_some();
    for name in candidates {
        if let Ok(obj) = repo.revparse_single(&name) {
            if let Ok(commit) = obj.peel_to_commit() {
                let label = if !explicit && name == "origin/HEAD" {
                    name.trim_start_matches("origin/").to_string()
                } else {
                    name.clone()
                };
                return Ok((label, commit.id()));
            }
        }
    }
    Err("could not resolve a base branch (tried origin/HEAD, main, master)".into())
}

pub fn resolve_endpoints(repo: &Repository, target: &Target) -> Result<Endpoints, GitError> {
    let head_ref = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_commit = head_ref.peel_to_commit().map_err(|e| format!("head commit: {e}"))?;
    let head_label = head_ref
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|| short_oid(head_commit.id()));

    match target.mode {
        DiffMode::Uncommitted => Ok(Endpoints {
            from_tree: Some(tree_of(repo, head_commit.id())?.id()),
            right: RightSide::WorkTree,
            base_label: head_label.clone(),
            head_label: "working tree".into(),
        }),
        DiffMode::LastCommit => {
            let parent = head_commit
                .parent(0)
                .map_err(|_| "last-commit: HEAD has no parent".to_string())?;
            Ok(Endpoints {
                from_tree: Some(tree_of(repo, parent.id())?.id()),
                right: RightSide::Tree(tree_of(repo, head_commit.id())?.id()),
                base_label: short_oid(parent.id()),
                head_label: short_oid(head_commit.id()),
            })
        }
        DiffMode::AllChanges | DiffMode::BranchVsBase => {
            let (base_label, base_oid) = resolve_base(repo, target.base.as_deref())?;
            let mb = repo
                .merge_base(head_commit.id(), base_oid)
                .map_err(|e| format!("merge-base: {e}"))?;
            let from_tree = Some(tree_of(repo, mb)?.id());
            let right = match target.mode {
                DiffMode::AllChanges => RightSide::WorkTree,
                _ => RightSide::Tree(tree_of(repo, head_commit.id())?.id()),
            };
            Ok(Endpoints { from_tree, right, base_label, head_label })
        }
    }
}

pub fn resolve_worktree(repo: &Repository) -> Result<String, GitError> {
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    if head.is_branch() {
        if let Some(name) = head.shorthand() {
            return Ok(name.to_string());
        }
    }
    let oid = head.peel_to_commit().map_err(|e| format!("head commit: {e}"))?.id();
    Ok(short_oid(oid))
}

fn short_oid(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// A repo with one commit on `main` adding `file.txt` = "line1\nline2\n".
    pub fn repo_with_commit() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // ensure branch is named main
        repo.set_head("refs/heads/main").ok();
        write(dir.path(), "file.txt", "line1\nline2\n");
        commit_all(&repo, "initial");
        (dir, repo)
    }

    pub fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    pub fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    /// Add a linked worktree checked out on a new branch `branch`, at a sibling dir.
    /// Returns the worktree's path.
    pub fn add_worktree(repo: &Repository, root: &Path, name: &str, branch: &str) -> std::path::PathBuf {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(branch, &head, false).unwrap();
        let wt_path = root.parent().unwrap().join(name);
        let reference = repo.find_reference(&format!("refs/heads/{branch}")).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(&reference));
        repo.worktree(name, &wt_path, Some(&opts)).unwrap();
        wt_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::test_support::*;

    #[test]
    fn mode_serializes_kebab_case() {
        let json = serde_json::to_string(&DiffMode::AllChanges).unwrap();
        assert_eq!(json, "\"all-changes\"");
    }

    #[test]
    fn resolve_base_finds_main() {
        let (_dir, repo) = repo_with_commit();
        let (label, _oid) = resolve_base(&repo, None).unwrap();
        assert_eq!(label, "main");
    }

    #[test]
    fn resolve_worktree_returns_branch_name() {
        let (_dir, repo) = repo_with_commit();
        assert_eq!(resolve_worktree(&repo).unwrap(), "main");
    }
}

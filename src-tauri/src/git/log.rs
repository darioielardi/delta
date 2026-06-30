use crate::git::model::Target;
use crate::git::{open_repo, resolve_base, GitError};
use git2::Sort;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

/// Commits on `merge-base(base, HEAD)..HEAD`, newest first.
pub fn list_commits(target: &Target) -> Result<Vec<CommitMeta>, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_oid = head
        .peel_to_commit()
        .map_err(|e| format!("head commit: {e}"))?
        .id();
    let (_label, base_oid) = resolve_base(&repo, target.base.as_deref())?;
    let mb = repo
        .merge_base(head_oid, base_oid)
        .map_err(|e| format!("merge-base: {e}"))?;

    let mut walk = repo.revwalk().map_err(|e| format!("revwalk: {e}"))?;
    walk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;
    // Always hide the merge-base: it excludes the base and its ancestors. When the
    // base resolves to HEAD's own branch (mb == HEAD) this correctly yields empty.
    walk.hide(mb).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.to_string())?;
        let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
        out.push(CommitMeta {
            oid: oid.to_string(),
            short_oid: oid.to_string().chars().take(7).collect(),
            subject: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::DiffMode;
    use crate::git::test_support::*;

    fn target(repo_path: &str) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode: DiffMode::Commit, base: None, commit: None }
    }

    #[test]
    fn lists_branch_commits_newest_first_excluding_base() {
        let (dir, repo) = repo_with_commit(); // main @ "initial"
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "a.txt", "1\n");
        let c1 = commit_all(&repo, "first on feature");
        write(dir.path(), "b.txt", "2\n");
        let c2 = commit_all(&repo, "second on feature");

        let commits = list_commits(&target(dir.path().to_str().unwrap())).unwrap();
        let oids: Vec<String> = commits.iter().map(|c| c.oid.clone()).collect();
        assert_eq!(oids, vec![c2.to_string(), c1.to_string()]); // newest first
        assert_eq!(commits[0].subject, "second on feature");
    }

    #[test]
    fn empty_when_head_is_base() {
        let (dir, _repo) = repo_with_commit(); // on main, no commits ahead of base(main)
        let commits = list_commits(&target(dir.path().to_str().unwrap())).unwrap();
        assert!(commits.is_empty());
    }
}

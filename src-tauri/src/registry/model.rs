use crate::git::model::Target;
use crate::review::model::{CommentScope, Review};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    /// RFC3339 time of the worktree HEAD's last commit (recency sort + display).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_commit_at: Option<String>,
    /// True when the worktree has uncommitted changes (staged or unstaged).
    #[serde(default)]
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub id: String,
    pub root: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub worktrees: Vec<WorktreeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    pub id: String,
    pub repo_name: String,
    pub target: Target,
    pub last_opened_at: String,
    pub comment_count: u32,
    pub stale_count: u32,
    #[serde(default)]
    pub resolved_count: u32,
    pub viewed_count: u32,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub reviews: Vec<ReviewEntry>,
    /// Absolute $HOME, populated on read (list_registry) so the UI can render
    /// ~-relative paths. Never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

impl Registry {
    pub fn empty() -> Self {
        Registry { version: 2, repos: Vec::new(), reviews: Vec::new(), home: None }
    }

    pub fn upsert_review(&mut self, entry: ReviewEntry) {
        match self.reviews.iter_mut().find(|r| r.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.reviews.push(entry),
        }
    }

    pub fn remove_review(&mut self, id: &str) {
        self.reviews.retain(|r| r.id != id);
    }

    pub fn upsert_repo(&mut self, entry: RepoEntry) {
        match self.repos.iter_mut().find(|r| r.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.repos.push(entry),
        }
    }
}

impl ReviewEntry {
    pub fn from_review(review: &Review, file_count: u32, repo_name: String) -> Self {
        let visible = |c: &&crate::review::model::Comment| c.scope != CommentScope::General;
        let comment_count = review.comments.iter().filter(visible).count() as u32;
        let stale_count = review.comments.iter().filter(|c| c.stale && visible(c)).count() as u32;
        let resolved_count = review.comments.iter().filter(|c| c.resolved && visible(c)).count() as u32;
        ReviewEntry {
            id: review.id.clone(),
            repo_name,
            target: review.target.clone(),
            last_opened_at: review.last_opened_at.clone(),
            comment_count,
            stale_count,
            resolved_count,
            viewed_count: review.viewed.len() as u32,
            file_count,
        }
    }
}

/// Basename of a repo/worktree path, falling back to the whole path.
pub fn repo_name_from_path(repo_path: &str) -> String {
    std::path::Path::new(repo_path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| repo_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Comment, CommentScope, Review, Snapshot, ViewedEntry};

    fn review_with(comments: Vec<Comment>, viewed: Vec<ViewedEntry>) -> Review {
        let target = Target {
            repo_path: "/Users/me/proj".into(),
            worktree: Some("main".into()),
            mode: DiffMode::AllChanges,
            base: None,
        };
        let mut r = Review::new(
            "0123456789abcdef".into(),
            target,
            Snapshot { base_oid: "b".into(), head_oid: None, captured_at: "t".into() },
            "t".into(),
        );
        r.comments = comments;
        r.viewed = viewed;
        r
    }

    fn comment(scope: CommentScope, stale: bool, resolved: bool) -> Comment {
        Comment {
            id: "x".into(),
            scope,
            anchor: None,
            body: "b".into(),
            stale,
            resolved,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn from_review_counts_exclude_general_and_track_stale_viewed() {
        let r = review_with(
            vec![
                comment(CommentScope::Line, false, false),
                comment(CommentScope::File, true, false),
                comment(CommentScope::General, false, false),
            ],
            vec![ViewedEntry { file: "a".into(), diff_hash: "h".into() }],
        );
        let e = ReviewEntry::from_review(&r, 7, "proj".into());
        assert_eq!(e.comment_count, 2, "general excluded");
        assert_eq!(e.stale_count, 1);
        assert_eq!(e.viewed_count, 1);
        assert_eq!(e.file_count, 7);
        assert_eq!(e.repo_name, "proj");
        assert_eq!(e.id, "0123456789abcdef");
    }

    #[test]
    fn from_review_counts_resolved_excluding_general() {
        let r = review_with(
            vec![
                comment(CommentScope::Line, false, true),    // resolved → counts
                comment(CommentScope::File, false, true),    // resolved → counts
                comment(CommentScope::Line, false, false),   // open
                comment(CommentScope::General, false, true), // resolved but general → excluded
            ],
            vec![],
        );
        let e = ReviewEntry::from_review(&r, 0, "proj".into());
        assert_eq!(e.resolved_count, 2);
    }

    #[test]
    fn upsert_review_replaces_by_id() {
        let mut reg = Registry::empty();
        let mut e = ReviewEntry::from_review(&review_with(vec![], vec![]), 1, "proj".into());
        reg.upsert_review(e.clone());
        e.file_count = 9;
        reg.upsert_review(e);
        assert_eq!(reg.reviews.len(), 1);
        assert_eq!(reg.reviews[0].file_count, 9);
    }

    #[test]
    fn remove_review_drops_entry() {
        let mut reg = Registry::empty();
        reg.upsert_review(ReviewEntry::from_review(&review_with(vec![], vec![]), 1, "proj".into()));
        reg.remove_review("0123456789abcdef");
        assert!(reg.reviews.is_empty());
    }

    #[test]
    fn repo_name_from_path_is_basename() {
        assert_eq!(repo_name_from_path("/Users/me/projects/delta"), "delta");
        assert_eq!(repo_name_from_path("/Users/me/projects/delta/"), "delta");
    }
}

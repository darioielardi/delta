use crate::anchor::{diff_hash, reanchor};
use crate::git::diff::{compute_diff, get_file_diff, DiffSummary};
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, resolve_worktree, GitError, RightSide};
use crate::review::model::{review_id, Review, Side, Snapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub review: Review,
    pub summary: DiffSummary,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Reconcile a review against the current repo state: re-resolve worktree/id,
/// recompute the diff, re-anchor comments (best-effort, else stale), reset viewed
/// where the file's diff changed, and refresh the snapshot.
pub fn reconcile(mut review: Review) -> Result<ReviewSession, GitError> {
    let repo = open_repo(&review.target.repo_path)?;
    let worktree = resolve_worktree(&repo)?;
    review.target.worktree = Some(worktree.clone());
    review.id = review_id(&review.target.repo_path, &worktree, review.target.mode);

    let summary = compute_diff(&review.target)?;
    let present: std::collections::HashSet<&str> =
        summary.files.iter().map(|f| f.path.as_str()).collect();

    // Re-anchor comments.
    let target = review.target.clone();
    for comment in &mut review.comments {
        let Some(anchor) = comment.anchor.as_mut() else {
            continue; // general note — no anchor
        };
        let has_lines = anchor.start_line.is_some() && anchor.snippet.is_some();
        if !has_lines {
            // file-scope: present in diff => fresh, else stale
            comment.stale = !present.contains(anchor.file.as_str());
            continue;
        }
        let content = file_side_content(&target, &anchor.file, anchor.side);
        match content {
            Some(content) => {
                match reanchor(
                    anchor.start_line.unwrap(),
                    anchor.snippet.as_deref().unwrap(),
                    &content,
                ) {
                    Some((start, end)) => {
                        anchor.start_line = Some(start);
                        anchor.end_line = end;
                        comment.stale = false;
                    }
                    None => comment.stale = true,
                }
            }
            None => comment.stale = true, // file removed from diff or binary
        }
    }

    // Reset viewed entries whose file diff changed (or vanished).
    review.viewed.retain(|v| match get_file_diff(&target, &v.file) {
        Ok(fd) => {
            diff_hash(
                fd.old_content.as_deref().unwrap_or(""),
                fd.new_content.as_deref().unwrap_or(""),
            ) == v.diff_hash
        }
        Err(_) => false,
    });

    // Refresh snapshot.
    let ep = resolve_endpoints(&repo, &review.target)?;
    review.snapshot = Snapshot {
        base_oid: ep.from_tree.map(|o| o.to_string()).unwrap_or_default(),
        head_oid: match ep.right {
            RightSide::Tree(o) => Some(o.to_string()),
            RightSide::WorkTree => None,
        },
        captured_at: now(),
    };
    review.last_opened_at = now();

    Ok(ReviewSession { review, summary })
}

fn file_side_content(target: &Target, file: &str, side: Side) -> Option<String> {
    let fd = get_file_diff(target, file).ok()?;
    match side {
        Side::New => fd.new_content,
        Side::Old => fd.old_content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot, ViewedEntry};

    fn empty_review(repo_path: &str) -> Review {
        let target = Target {
            repo_path: repo_path.into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
        };
        Review::new(
            "id".into(),
            target,
            Snapshot { base_oid: "".into(), head_oid: None, captured_at: "".into() },
            "t".into(),
        )
    }

    fn line_comment(file: &str, line: u32, snippet: &str) -> Comment {
        Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: Some(Anchor {
                file: file.into(),
                side: Side::New,
                start_line: Some(line),
                end_line: None,
                snippet: Some(snippet.into()),
            }),
            body: "b".into(),
            stale: false,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn reanchors_moved_comment_and_clears_stale() {
        let (dir, _repo) = repo_with_commit(); // file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "inserted\nline1\nline2\n"); // line1 moved 1->2
        let mut r = empty_review(dir.path().to_str().unwrap());
        let mut c = line_comment("file.txt", 1, "line1");
        c.stale = true;
        r.comments.push(c);
        let session = reconcile(r).unwrap();
        let a = session.review.comments[0].anchor.as_ref().unwrap();
        assert_eq!(a.start_line, Some(2));
        assert_eq!(session.review.comments[0].stale, false);
    }

    #[test]
    fn marks_stale_when_snippet_gone() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "completely\ndifferent\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.comments.push(line_comment("file.txt", 1, "line1"));
        let session = reconcile(r).unwrap();
        assert_eq!(session.review.comments[0].stale, true);
    }

    #[test]
    fn keeps_viewed_when_diff_unchanged_drops_when_changed() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\n");
        // capture the current diff hash for file.txt by reconciling once
        let r = empty_review(dir.path().to_str().unwrap());
        let first = reconcile(r.clone()).unwrap();
        // mark viewed with the correct current hash
        let fd =
            crate::git::diff::get_file_diff(&first.review.target, "file.txt").unwrap();
        let h = crate::anchor::diff_hash(
            fd.old_content.as_deref().unwrap_or(""),
            fd.new_content.as_deref().unwrap_or(""),
        );
        let mut r = first.review;
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: h });
        let kept = reconcile(r.clone()).unwrap();
        assert_eq!(kept.review.viewed.len(), 1);
        // now change the file -> viewed should drop
        write(dir.path(), "file.txt", "line1\nCHANGED-AGAIN\n");
        let dropped = reconcile(r).unwrap();
        assert_eq!(dropped.review.viewed.len(), 0);
    }
}

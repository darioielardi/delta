use crate::review::model::{Comment, CommentScope, Review, Side};
use std::collections::BTreeMap;

pub fn export_markdown(review: &Review) -> String {
    let mut out = String::new();
    let t = &review.target;
    let worktree = t.worktree.as_deref().unwrap_or("");
    out.push_str(&format!("# Review — {} · {} · {}\n", t.repo_path, worktree, t.mode.as_str()));
    let head = review.snapshot.head_oid.as_deref().unwrap_or("working tree");
    out.push_str(&format!("Base {} ⇢ head {} · captured {}\n\n", review.snapshot.base_oid, head, review.snapshot.captured_at));

    // General first.
    let generals: Vec<&Comment> = review.comments.iter().filter(|c| c.scope == CommentScope::General).collect();
    if !generals.is_empty() {
        out.push_str("## General\n");
        for c in generals {
            out.push_str(&format!("- {}{}\n", stale_tag(c), c.body.trim()));
        }
        out.push('\n');
    }

    // Group the rest by file, preserving anchored line order.
    let mut by_file: BTreeMap<String, Vec<&Comment>> = BTreeMap::new();
    for c in review.comments.iter().filter(|c| c.scope != CommentScope::General) {
        if let Some(a) = &c.anchor {
            by_file.entry(a.file.clone()).or_default().push(c);
        }
    }
    for (file, mut comments) in by_file {
        comments.sort_by_key(|c| c.anchor.as_ref().and_then(|a| a.start_line).unwrap_or(0));
        out.push_str(&format!("## {file}\n\n"));
        let lang = match file.rsplit_once('.') {
            Some((_, ext)) if !ext.contains('/') => ext,
            _ => "",
        };
        for c in comments {
            let a = c.anchor.as_ref().unwrap();
            let header = match c.scope {
                CommentScope::File => "#### File-level".to_string(),
                CommentScope::Range => match (a.start_line, a.end_line) {
                    (Some(s), Some(e)) => format!("#### L{s}–{e}"),
                    (Some(s), _) => format!("#### L{s}"),
                    _ => "#### File-level".to_string(),
                },
                _ => a.start_line.map(|s| format!("#### L{s}")).unwrap_or_else(|| "#### File-level".to_string()),
            };
            let side_note = if a.side == Side::Old { " · old-side" } else { "" };
            out.push_str(&format!("{header}{side_note}{}\n", stale_suffix(c)));
            if let Some(snippet) = &a.snippet {
                out.push_str(&format!("```{lang}\n{}\n```\n", snippet.trim_end()));
            }
            out.push_str(&format!("{}\n\n", c.body.trim()));
        }
    }

    out
}

fn stale_tag(c: &Comment) -> &'static str {
    if c.stale { "⚠ stale — " } else { "" }
}

fn stale_suffix(c: &Comment) -> &'static str {
    if c.stale { " · ⚠ stale" } else { "" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Anchor, CommentScope, Snapshot};

    fn review_with(comments: Vec<Comment>) -> Review {
        let target = Target { repo_path: "/r".into(), worktree: Some("feat/auth".into()), mode: DiffMode::BranchVsBase, base: Some("main".into()) };
        let mut r = Review::new("id".into(), target, Snapshot { base_oid: "a1b2c3d".into(), head_oid: Some("e4f5g6h".into()), captured_at: "2026-06-25T18:54:00Z".into() }, "t".into());
        r.comments = comments;
        r
    }

    fn cmt(scope: CommentScope, anchor: Option<Anchor>, body: &str, stale: bool) -> Comment {
        Comment { id: "x".into(), scope, anchor, body: body.into(), stale, resolved: false, created_at: "t".into(), updated_at: "t".into() }
    }

    #[test]
    fn general_section_comes_first() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("export const TTL = 3600".into()) }), "make configurable", false),
            cmt(CommentScope::General, None, "standardize errors", false),
        ]));
        let general_pos = md.find("## General").unwrap();
        let file_pos = md.find("## src/a.ts").unwrap();
        assert!(general_pos < file_pos, "General must precede file sections");
        assert!(md.contains("standardize errors"));
    }

    #[test]
    fn line_comment_has_location_snippet_and_body() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("export const TTL = 3600".into()) }), "make configurable", false),
        ]));
        assert!(md.contains("#### L40"));
        assert!(md.contains("```ts"));
        assert!(md.contains("export const TTL = 3600"));
        assert!(md.contains("make configurable"));
    }

    #[test]
    fn stale_is_marked_not_dropped() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::Old, start_line: Some(8), end_line: None, snippet: Some("if (!token) return null".into()) }), "redundant guard", true),
        ]));
        assert!(md.contains("⚠ stale"));
        assert!(md.contains("redundant guard"));
        assert!(md.contains("old-side"));
    }
}

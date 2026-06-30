// Controlled input assembly: the bounded diff payload, the min-diff floor, and the
// canonical diff signature used for caching. Nothing here shells out — it shapes
// exactly what the model sees. (#guide)
use crate::git::diff::{build_diff, DiffSummary, FileStatus};
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, GitError};
use sha2::{Digest, Sha256};

/// Above this many bytes of unified patch, fall back to a name-status summary and
/// mark the walkthrough `degraded` — the model orients from structure, not full text.
pub const WALKTHROUGH_DIFF_BUDGET: usize = 256 * 1024;

/// Diffs with fewer total changed lines than this aren't worth a walkthrough; the
/// frontend pre-gates with a popup, the backend keeps this as a defensive floor.
pub const MIN_CHANGED_LINES: usize = 20;

/// Total added+deleted lines across the non-binary files in the diff.
pub fn total_changed_lines(summary: &DiffSummary) -> usize {
    summary
        .files
        .iter()
        .filter(|f| !f.binary)
        .map(|f| f.additions + f.deletions)
        .sum()
}

fn status_letter(s: FileStatus) -> char {
    match s {
        FileStatus::Added => 'A',
        FileStatus::Modified => 'M',
        FileStatus::Deleted => 'D',
        FileStatus::Renamed => 'R',
    }
}

/// Degraded payload: one line per file with status + churn, no bodies.
pub fn name_status_payload(summary: &DiffSummary) -> String {
    let mut out = String::new();
    for f in &summary.files {
        out.push_str(&format!(
            "{}\t{} (+{} -{})\n",
            status_letter(f.status),
            f.path,
            f.additions,
            f.deletions
        ));
    }
    out
}

/// Canonical signature of the diff + injected context. Stable across runs, flips
/// when any file's churn/status changes, the endpoints move, or CLAUDE.md changes.
/// 16 hex chars of SHA-256, mirroring `review_id`.
pub fn diff_sig(summary: &DiffSummary, repo_context: &str) -> String {
    let mut lines: Vec<String> = summary
        .files
        .iter()
        .map(|f| format!("{}|{:?}|{}|{}", f.path, f.status, f.additions, f.deletions))
        .collect();
    lines.sort();

    let mut h = Sha256::new();
    h.update(lines.join("\n").as_bytes());
    h.update(format!("\0{}\0{}\0", summary.base_label, summary.head_label).as_bytes());
    let mut ctx = Sha256::new();
    ctx.update(repo_context.as_bytes());
    h.update(ctx.finalize());
    h.finalize()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The full unified patch when it fits the budget, else a name-status summary.
/// Returns `(payload, degraded)`.
pub fn diff_payload(target: &Target, summary: &DiffSummary) -> Result<(String, bool), GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;
    let mut buf: Vec<u8> = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            buf.push(line.origin() as u8);
        }
        buf.extend_from_slice(line.content());
        true
    })
    .map_err(|e| format!("print diff: {e}"))?;

    if buf.len() > WALKTHROUGH_DIFF_BUDGET {
        return Ok((name_status_payload(summary), true));
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{compute_diff, DiffSummary, FileEntry, FileStatus};
    use crate::git::model::DiffMode;
    use crate::git::test_support::*;

    fn fe(path: &str, a: usize, d: usize) -> FileEntry {
        FileEntry { path: path.into(), old_path: None, status: FileStatus::Modified, additions: a, deletions: d, binary: false }
    }
    fn summ(files: Vec<FileEntry>) -> DiffSummary {
        DiffSummary { files, base_label: "main".into(), head_label: "HEAD".into() }
    }

    #[test]
    fn total_changed_lines_sums_non_binary() {
        let mut bin = fe("img.png", 99, 99);
        bin.binary = true;
        assert_eq!(total_changed_lines(&summ(vec![fe("a", 3, 2), fe("b", 5, 0), bin])), 10);
    }

    #[test]
    fn diff_sig_is_stable_and_sensitive() {
        let s1 = diff_sig(&summ(vec![fe("a", 1, 1)]), "ctx");
        assert_eq!(s1, diff_sig(&summ(vec![fe("a", 1, 1)]), "ctx"));
        assert_ne!(s1, diff_sig(&summ(vec![fe("a", 2, 1)]), "ctx"), "line change flips");
        assert_ne!(s1, diff_sig(&summ(vec![fe("a", 1, 1)]), "ctx2"), "CLAUDE.md change flips");
        assert_eq!(s1.len(), 16);
        assert!(s1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn name_status_payload_is_one_line_per_file() {
        let p = name_status_payload(&summ(vec![fe("a.ts", 3, 1), fe("b.ts", 0, 4)]));
        assert!(p.contains("M\ta.ts (+3 -1)"));
        assert!(p.contains("M\tb.ts (+0 -4)"));
    }

    #[test]
    fn diff_payload_returns_patch_text_for_small_change() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let summary = compute_diff(&target).unwrap();
        let (payload, degraded) = diff_payload(&target, &summary).unwrap();
        assert!(!degraded);
        assert!(payload.contains("CHANGED"), "patch should contain the changed line, got: {payload}");
    }
}

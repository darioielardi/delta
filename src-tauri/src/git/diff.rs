use crate::git::lang::lang_for;
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, Endpoints, GitError, RightSide};
use git2::{Diff, DiffFindOptions, DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<FileEntry>,
    pub base_label: String,
    pub head_label: String,
}

pub fn build_diff<'r>(repo: &'r Repository, ep: &Endpoints) -> Result<Diff<'r>, GitError> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    // ep.from_tree and RightSide::Tree carry tree OIDs (not commit OIDs),
    // as produced by tree_of() in resolve_endpoints.
    let from_tree = match ep.from_tree {
        Some(oid) => Some(repo.find_tree(oid).map_err(|e| e.to_string())?),
        None => None,
    };

    let mut diff = match &ep.right {
        RightSide::WorkTree => repo
            .diff_tree_to_workdir_with_index(from_tree.as_ref(), Some(&mut opts))
            .map_err(|e| format!("diff workdir: {e}"))?,
        RightSide::Tree(oid) => {
            let to = repo.find_tree(*oid).map_err(|e| e.to_string())?;
            repo.diff_tree_to_tree(from_tree.as_ref(), Some(&to), Some(&mut opts))
                .map_err(|e| format!("diff trees: {e}"))?
        }
    };

    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| format!("find renames: {e}"))?;

    Ok(diff)
}

fn map_status(s: git2::Delta) -> FileStatus {
    match s {
        git2::Delta::Added | git2::Delta::Untracked | git2::Delta::Copied => FileStatus::Added,
        git2::Delta::Deleted => FileStatus::Deleted,
        git2::Delta::Renamed => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

pub fn compute_diff(target: &Target) -> Result<DiffSummary, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let mut files = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let old_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let path = new_path
            .clone()
            .or_else(|| old_path.clone())
            .unwrap_or_default();

        let (additions, deletions) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(p)) => {
                let (_ctx, add, del) = p.line_stats().unwrap_or((0, 0, 0));
                (add, del)
            }
            _ => (0, 0),
        };

        files.push(FileEntry {
            path,
            old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
            status: map_status(delta.status()),
            additions,
            deletions,
            binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
        });
    }

    Ok(DiffSummary {
        files,
        base_label: ep.base_label,
        head_label: ep.head_label,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_file_name: Option<String>,
    pub old_content: Option<String>,
    pub old_lang: Option<String>,
    pub new_file_name: Option<String>,
    pub new_content: Option<String>,
    pub new_lang: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
}

/// Git's binary heuristic: a NUL byte within the first 8000 bytes means binary.
/// git2's `is_binary()` flag isn't reliably set during delta iteration, so we
/// also inspect the content ourselves — otherwise PNGs etc. render as garbage.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

pub fn get_file_diff(target: &Target, path: &str) -> Result<FileDiff, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    // Locate the delta for this path (match new path, else old path).
    let delta = diff
        .deltas()
        .find(|d| {
            d.new_file()
                .path()
                .map(|p| p.to_string_lossy() == path)
                .unwrap_or(false)
                || d.old_file()
                    .path()
                    .map(|p| p.to_string_lossy() == path)
                    .unwrap_or(false)
        })
        .ok_or_else(|| format!("file not in diff: {path}"))?;

    let status = map_status(delta.status());

    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().to_string());
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().to_string());

    // Read raw bytes first so we can detect binary content ourselves.
    // Old bytes: ep.from_tree is a tree OID (not commit OID); use find_tree directly.
    let old_bytes: Option<Vec<u8>> = match (ep.from_tree, &old_path) {
        (Some(tree_oid), Some(op)) => {
            let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
            match tree.get_path(std::path::Path::new(op)) {
                Ok(entry) => repo.find_blob(entry.id()).ok().map(|b| b.content().to_vec()),
                Err(_) => None, // added file: not in old tree
            }
        }
        _ => None,
    };
    // New bytes: from the working tree (worktree modes) or the new blob (tree modes).
    let new_bytes: Option<Vec<u8>> = match (&ep.right, &new_path) {
        (RightSide::WorkTree, Some(np)) => {
            let wd = repo.workdir().ok_or("no working directory")?;
            fs::read(wd.join(np)).ok()
        }
        (RightSide::Tree(_), Some(_np)) => {
            let blob_id = delta.new_file().id();
            if blob_id.is_zero() {
                None
            } else {
                repo.find_blob(blob_id).ok().map(|b| b.content().to_vec())
            }
        }
        _ => None,
    };

    let binary = delta.new_file().is_binary()
        || delta.old_file().is_binary()
        || old_bytes.as_deref().map(looks_binary).unwrap_or(false)
        || new_bytes.as_deref().map(looks_binary).unwrap_or(false);

    // Drop content for binary files — the UI shows an "Unsupported file" placeholder.
    let old_content = if binary { None } else { old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };
    let new_content = if binary { None } else { new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };

    Ok(FileDiff {
        old_lang: old_path.as_deref().and_then(lang_for),
        new_lang: new_path.as_deref().and_then(lang_for),
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        status,
        binary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::lang::lang_for;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode, base: None }
    }

    #[test]
    fn file_diff_returns_old_and_new_content() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let fd = get_file_diff(
            &Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None },
            "file.txt",
        ).unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
        assert_eq!(fd.new_lang.as_deref(), None); // .txt → no lang
    }

    #[test]
    fn binary_file_is_flagged_and_content_omitted() {
        let (dir, _repo) = repo_with_commit();
        // an untracked "png" with NUL bytes
        std::fs::write(dir.path().join("logo.png"), [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00]).unwrap();
        let fd = get_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "logo.png",
        )
        .unwrap();
        assert!(fd.binary, "png with NUL bytes should be flagged binary");
        assert!(fd.new_content.is_none(), "binary content must be omitted");
    }

    #[test]
    fn lang_for_maps_typescript() {
        assert_eq!(lang_for("src/a.ts").as_deref(), Some("typescript"));
    }

    #[test]
    fn uncommitted_lists_modified_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");
        assert_eq!(summary.files[0].status, FileStatus::Modified);
    }

    #[test]
    fn uncommitted_lists_untracked_new_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "new.txt", "hello\n");
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let new_file = summary.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new_file.status, FileStatus::Added);
    }

    #[test]
    fn clean_tree_all_changes_is_empty() {
        let (dir, _repo) = repo_with_commit();
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::AllChanges)).unwrap();
        assert_eq!(summary.files.len(), 0);
    }

    // Repro for the "uncommitted shows the whole file as new" report. The file is
    // new relative to main but committed on the feature branch, then has a couple
    // uncommitted edits. Uncommitted (HEAD→workdir) must show Modified, not Added.
    #[test]
    fn uncommitted_branch_new_file_shows_modified_not_added() {
        let (dir, repo) = repo_with_commit(); // main: file.txt
        // branch off and commit a brand-new file
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "feature.txt", "a\nb\nc\n");
        commit_all(&repo, "add feature.txt on feature");
        // a couple uncommitted edits
        write(dir.path(), "feature.txt", "a\nCHANGED\nc\n");

        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let f = summary.files.iter().find(|f| f.path == "feature.txt").unwrap();
        assert_eq!(f.status, FileStatus::Modified, "expected Modified, got {:?}", f.status);

        let fd = get_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "feature.txt",
        )
        .unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("a\nb\nc\n"), "old content must be HEAD's");
    }

    #[test]
    fn uncommitted_in_linked_worktree_shows_modified_not_added() {
        use git2::WorktreeAddOptions;
        let (dir, repo) = repo_with_commit(); // main: file.txt
        // create a linked worktree on a new branch
        let wt_parent = tempfile::TempDir::new().unwrap();
        let wt_path = wt_parent.path().join("wt");
        let wt = repo
            .worktree("feat", &wt_path, Some(&WorktreeAddOptions::new()))
            .unwrap();
        let wt_repo = Repository::open_from_worktree(&wt).unwrap();
        // commit a brand-new file on the worktree's branch
        write(&wt_path, "feature.txt", "a\nb\nc\n");
        commit_all(&wt_repo, "add feature.txt in worktree");
        // a couple uncommitted edits in the worktree
        write(&wt_path, "feature.txt", "a\nCHANGED\nc\n");

        let summary =
            compute_diff(&target(wt_path.to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let f = summary.files.iter().find(|f| f.path == "feature.txt").unwrap();
        assert_eq!(f.status, FileStatus::Modified, "expected Modified, got {:?}", f.status);
    }
}

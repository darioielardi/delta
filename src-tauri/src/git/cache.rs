//! Process-wide diff cache. A per-file fetch used to re-run the whole-repo diff
//! (build + rename detection) every call — O(files) redundant work that dominated
//! large reviews. This memoizes one diff *snapshot* (summary + every file's
//! content, built once by `compute_diff_full`) so each `get_file_diff` is a map
//! read. Held in Tauri managed state; the fs watcher `invalidate`s it when the
//! worktree changes so working-tree diffs never go stale. (#perf)
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::git::diff::{compute_diff_full, get_file_diff, DiffSummary, FileDiff};
use crate::git::model::{DiffMode, Target};
use crate::git::{open_repo, resolve_endpoints, GitError, RightSide};

/// Identity of a diff snapshot: the target plus the resolved endpoint OIDs. For
/// tree↔tree modes the OIDs pin the content exactly (a moved HEAD → new key →
/// rebuild); working-tree modes carry a `workdir` token, so their freshness rides
/// on the watcher calling `invalidate`.
#[derive(PartialEq, Eq, Clone)]
struct SnapshotKey {
    repo_path: String,
    worktree: Option<String>,
    mode: DiffMode,
    base: Option<String>,
    commit: Option<String>,
    from_oid: String,
    to_token: String,
}

struct Snapshot {
    key: SnapshotKey,
    summary: DiffSummary,
    files: HashMap<String, FileDiff>,
}

/// Single-slot cache of the most-recent diff snapshot. One review window works one
/// target at a time, so a single slot serves the hot path; switching target just
/// rebuilds once (still one whole-repo diff, versus one *per file* before). Cloning
/// is cheap (shared `Arc`) so a command can move a handle into `spawn_blocking` and
/// the fs watcher can hold its own.
#[derive(Default, Clone)]
pub struct DiffCache(Arc<Mutex<Option<Snapshot>>>);

/// Same worktree on disk? Cheap string-eq first, then a best-effort canonicalize so
/// the watcher's canonical root still matches a target opened by a symlinked path.
fn same_worktree(a: &str, b: &str) -> bool {
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

impl DiffCache {
    fn key_for(target: &Target) -> Result<SnapshotKey, GitError> {
        let repo = open_repo(&target.repo_path)?;
        let ep = resolve_endpoints(&repo, target)?;
        Ok(SnapshotKey {
            repo_path: target.repo_path.clone(),
            worktree: target.worktree.clone(),
            mode: target.mode,
            base: target.base.clone(),
            commit: target.commit.clone(),
            from_oid: ep.from_tree.map(|o| o.to_string()).unwrap_or_default(),
            to_token: match ep.right {
                RightSide::Tree(o) => o.to_string(),
                RightSide::WorkTree => "workdir".into(),
            },
        })
    }

    /// The file-list summary for `target`, building (and caching) the snapshot on a
    /// miss. Resolving the key is cheap (revparse + merge-base); the whole-repo diff
    /// runs only when the key changed.
    pub fn summary(&self, target: &Target) -> Result<DiffSummary, GitError> {
        let key = Self::key_for(target)?;
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().map_or(true, |s| s.key != key) {
            let (summary, files) = compute_diff_full(target)?;
            *slot = Some(Snapshot { key, summary, files });
        }
        Ok(slot.as_ref().unwrap().summary.clone())
    }

    /// One file's diff for `target`. A map read once the snapshot is built; the build
    /// happens at most once per snapshot (concurrent first-fetches serialize on the
    /// lock, so only one runs the diff). Files too large to cache fall back to a
    /// one-off `get_file_diff`.
    pub fn file(&self, target: &Target, path: &str) -> Result<FileDiff, GitError> {
        let key = Self::key_for(target)?;
        {
            let mut slot = self.0.lock().unwrap();
            if slot.as_ref().map_or(true, |s| s.key != key) {
                let (summary, files) = compute_diff_full(target)?;
                *slot = Some(Snapshot { key, summary, files });
            }
            if let Some(fd) = slot.as_ref().unwrap().files.get(path) {
                return Ok(fd.clone());
            }
        } // drop the lock before the fallback does its own repo work
        get_file_diff(target, path)
    }

    /// Drop the cached snapshot if it belongs to `worktree` (the path the fs watcher
    /// watches). Called on `fs:changed` so a working-tree edit is reflected on the
    /// next fetch; a no-op when the slot holds a different worktree.
    pub fn invalidate(&self, worktree: &str) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|s| same_worktree(&s.key.repo_path, worktree)) {
            *slot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::MAX_CACHED_FILE_BYTES;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode, base: None, commit: None }
    }

    #[test]
    fn serves_summary_and_file_from_one_computation() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let summary = cache.summary(&t).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");

        let fd = cache.file(&t, "file.txt").unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
    }

    #[test]
    fn memoizes_snapshot_until_invalidated() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let repo_path = dir.path().to_str().unwrap().to_string();
        let t = target(&repo_path, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        // First read builds the snapshot and returns AAA.
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nAAA\nline2\n"));

        // The working tree changes, but with no invalidation the cache keeps serving
        // the memoized snapshot — this is the whole point: per-file fetches are map
        // reads, not a fresh whole-repo diff each time.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nAAA\nline2\n"));

        // The fs watcher fires → invalidate → the next read rebuilds and sees BBB.
        cache.invalidate(&repo_path);
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nBBB\nline2\n"));
    }

    #[test]
    fn falls_back_for_file_too_large_to_cache() {
        let (dir, _repo) = repo_with_commit();
        // A file above the per-file cap is left out of the cached snapshot, so it must
        // still be served (via a one-off diff), never reported missing.
        let big = "x".repeat(MAX_CACHED_FILE_BYTES as usize + 1024);
        write(dir.path(), "big.txt", &big);
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let fd = cache.file(&t, "big.txt").unwrap();
        assert_eq!(fd.new_content.as_deref(), Some(big.as_str()));
    }

    #[test]
    fn invalidate_only_drops_the_matching_worktree() {
        let (dir_a, _a) = repo_with_commit();
        write(dir_a.path(), "file.txt", "A1\n");
        let path_a = dir_a.path().to_str().unwrap().to_string();
        let t = target(&path_a, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("A1\n"));
        // Invalidating an unrelated worktree must NOT drop this snapshot.
        cache.invalidate("/some/other/worktree");
        write(dir_a.path(), "file.txt", "A2\n");
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("A1\n"), "unrelated invalidate must not evict");
    }
}

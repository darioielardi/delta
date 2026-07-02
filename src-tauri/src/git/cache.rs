//! Process-wide diff cache. A per-file fetch used to re-run the whole-repo diff
//! (build + rename detection) every call — O(files) redundant work that dominated
//! large reviews. This memoizes diff *snapshots* (summary + every file's content,
//! built once by `compute_diff_full`) so each `get_file_diff` is a map read.
//!
//! Held in Tauri managed state. Snapshots are keyed by *target identity*
//! (repo/mode/base/commit) — not resolved OIDs — so the hot per-file path does zero
//! git work on a hit. Freshness therefore rides entirely on `invalidate`: the fs
//! watcher calls it on any working-tree/`.git` change, and `refresh_review` calls it
//! on a manual refresh. Committed-commit snapshots are immutable, and every other
//! mode's content-changing event (edit, commit, checkout, fetch) trips the watcher,
//! so a cached snapshot is only ever served for state the watcher would not have
//! invalidated. (#perf)
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::git::diff::{compute_diff_full, get_file_diff, DiffSummary, FileDiff};
use crate::git::model::{DiffMode, Target};
use crate::git::GitError;

/// Most recent snapshots to retain. A small LRU (not a single slot) so multiple
/// review windows on different targets don't evict each other. Per-snapshot content
/// is bounded by the MAX_CACHED_* caps in `diff.rs`, so held memory stays bounded.
const MAX_SNAPSHOTS: usize = 4;

/// Identity of a diff snapshot = its target. The diff content is fully determined by
/// (repo_path, mode, base, commit); resolved OIDs are deliberately NOT part of the
/// key (see the module doc — freshness comes from `invalidate`, so the hit path
/// avoids resolving them).
#[derive(PartialEq, Eq, Clone)]
struct SnapshotKey {
    repo_path: String,
    mode: DiffMode,
    base: Option<String>,
    commit: Option<String>,
}

fn key_of(target: &Target) -> SnapshotKey {
    SnapshotKey {
        repo_path: target.repo_path.clone(),
        mode: target.mode,
        base: target.base.clone(),
        commit: target.commit.clone(),
    }
}

struct Snapshot {
    key: SnapshotKey,
    summary: DiffSummary,
    files: HashMap<String, FileDiff>,
}

/// Bounded LRU of recent diff snapshots. Cloning the handle is cheap (shared `Arc`)
/// so a command can move one into `spawn_blocking` and the fs watcher can hold its
/// own; the snapshots themselves are `Arc`-shared so reads clone content off-lock.
#[derive(Default, Clone)]
pub struct DiffCache(Arc<Mutex<Vec<Arc<Snapshot>>>>);

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
    /// Lock the cache, recovering from a poisoned mutex instead of panicking — a
    /// panic under the guard must not brick diff fetching for the rest of the session.
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Arc<Snapshot>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The snapshot for `target`, built on a miss. Shared by `summary` and `file`.
    /// The whole-repo build runs under the lock so concurrent first-fetches of the
    /// same target dedup onto one diff (rather than each running their own); the
    /// returned `Arc` then lets callers clone content out *after* the lock is dropped.
    fn snapshot(&self, target: &Target) -> Result<Arc<Snapshot>, GitError> {
        let key = key_of(target);
        let mut cache = self.lock();
        if let Some(pos) = cache.iter().position(|s| s.key == key) {
            let hit = cache.remove(pos);
            cache.push(hit.clone()); // most-recently-used at the back
            return Ok(hit);
        }
        let (summary, files) = compute_diff_full(target)?;
        let snap = Arc::new(Snapshot { key, summary, files });
        cache.push(snap.clone());
        if cache.len() > MAX_SNAPSHOTS {
            cache.remove(0); // evict least-recently-used (front)
        }
        Ok(snap)
    }

    /// The file-list summary for `target` (builds + caches the snapshot on a miss).
    pub fn summary(&self, target: &Target) -> Result<DiffSummary, GitError> {
        Ok(self.snapshot(target)?.summary.clone())
    }

    /// One file's diff for `target` — a map read once the snapshot is built. Files
    /// too large to cache aren't in the map and fall back to a one-off `get_file_diff`.
    pub fn file(&self, target: &Target, path: &str) -> Result<FileDiff, GitError> {
        let snap = self.snapshot(target)?;
        if let Some(fd) = snap.files.get(path) {
            return Ok(fd.clone());
        }
        get_file_diff(target, path)
    }

    /// Drop cached snapshots for `worktree` (the path the fs watcher watches, or the
    /// target's repo path on manual refresh) so the next fetch rebuilds against
    /// current content. A no-op for snapshots of other worktrees.
    pub fn invalidate(&self, worktree: &str) {
        self.lock().retain(|s| !same_worktree(&s.key.repo_path, worktree));
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

    #[test]
    fn keeps_snapshots_for_multiple_targets() {
        let (dir_a, _a) = repo_with_commit();
        write(dir_a.path(), "file.txt", "A\n");
        let (dir_b, _b) = repo_with_commit();
        write(dir_b.path(), "file.txt", "B\n");
        let ta = target(dir_a.path().to_str().unwrap(), DiffMode::Uncommitted);
        let tb = target(dir_b.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        assert_eq!(cache.file(&ta, "file.txt").unwrap().new_content.as_deref(), Some("A\n"));
        // A second target must not evict the first (no single-slot thrash).
        assert_eq!(cache.file(&tb, "file.txt").unwrap().new_content.as_deref(), Some("B\n"));
        // Change A without invalidating; A's snapshot must survive building B — with a
        // single slot it would have been evicted and this would rebuild to "A2".
        write(dir_a.path(), "file.txt", "A2\n");
        assert_eq!(cache.file(&ta, "file.txt").unwrap().new_content.as_deref(), Some("A\n"), "target A must survive building target B");
    }
}

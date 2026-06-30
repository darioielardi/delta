// AI-guidance walkthrough backend: compute the diff, assemble a controlled stdin
// payload (bounded patch + self-read repo CLAUDE.md/docs), shell out to the local
// `claude` CLI under `--safe-mode`, then validate the JSON against the quality
// invariants. Results are cached on the review by diff signature. (#guide)
pub mod claude;
pub mod context;
pub mod model;
pub mod prompt;

use crate::git::diff::compute_diff;
use crate::git::model::Target;
use crate::git::{open_repo, resolve_worktree};
use crate::review::model::{review_id, Review, Snapshot};
use crate::storage::Storage;
use crate::walkthrough::claude::{generate_with_runner, ClaudeRunner};
use crate::walkthrough::context::{diff_payload, diff_sig, is_too_small, repo_context};
use crate::walkthrough::model::{CachedWalkthrough, ClaudeStatus, Walkthrough, WalkthroughError};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// In-flight `claude` child PIDs keyed by review id — at most one per review (a
/// superseding generation overwrites). Lets `cancel_walkthrough` kill the running
/// process so a navigated-away generation stops spending credits. Cloneable (Arc
/// inside) so it threads through `spawn_blocking` and into the runner. (#guide)
#[derive(Clone, Default)]
pub struct ChildRegistry(Arc<Mutex<HashMap<String, u32>>>);

impl ChildRegistry {
    pub fn register(&self, review_id: &str, pid: u32) {
        self.0.lock().unwrap().insert(review_id.to_string(), pid);
    }

    /// Remove the entry iff it still holds `pid` — never clobber a newer run's PID.
    pub fn remove(&self, review_id: &str, pid: u32) {
        let mut m = self.0.lock().unwrap();
        if m.get(review_id) == Some(&pid) {
            m.remove(review_id);
        }
    }

    /// Kill the in-flight child for `review_id`, if any. Returns whether one was killed.
    pub fn kill(&self, review_id: &str) -> bool {
        let pid = self.0.lock().unwrap().remove(review_id);
        match pid {
            Some(pid) => {
                kill_pid(pid);
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    pub fn pid_of(&self, review_id: &str) -> Option<u32> {
        self.0.lock().unwrap().get(review_id).copied()
    }
}

#[cfg(unix)]
pub(crate) fn kill_pid(pid: u32) {
    // SAFETY: kill(2) on a PID we spawned. A reaped/reused PID is a theoretical race;
    // the window is tiny and the worst case is a no-op or EPERM, both harmless.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}
#[cfg(not(unix))]
pub(crate) fn kill_pid(_pid: u32) {}

/// Resolve the `claude` CLI to an absolute path. A GUI-launched macOS app inherits a
/// minimal PATH, so search the usual install dirs on top of $PATH (mirrors the editor
/// resolver in commands.rs).
pub fn resolve_claude() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/bin"));
        dirs.push(PathBuf::from(&home).join("bin"));
        dirs.push(PathBuf::from(&home).join(".claude/local"));
    }
    dirs.into_iter().map(|d| d.join("claude")).find(|c| c.is_file())
}

/// Pre-flight presence check for the walkthrough button gate.
pub fn claude_status_impl() -> ClaudeStatus {
    match resolve_claude() {
        Some(p) => ClaudeStatus { installed: true, path: Some(p.to_string_lossy().into_owned()) },
        None => ClaudeStatus { installed: false, path: None },
    }
}

/// Generate (or reuse the cached) walkthrough for `target`. `make_runner` builds the
/// claude runner once the review id is known — the real path resolves `claude` (and may
/// return `NotInstalled`); tests inject a fake. The result is cached on the review,
/// keyed by the diff signature, and reused on a matching, non-forced call. (#guide)
pub fn generate_walkthrough_impl<F>(
    storage: &dyn Storage,
    target: Target,
    force: bool,
    make_runner: F,
) -> Result<Walkthrough, WalkthroughError>
where
    F: FnOnce(&str) -> Result<Box<dyn ClaudeRunner>, WalkthroughError>,
{
    let repo = open_repo(&target.repo_path).map_err(WalkthroughError::Git)?;
    let worktree = resolve_worktree(&repo).map_err(WalkthroughError::Git)?;
    let mut target = target;
    target.worktree = Some(worktree.clone());
    let id = review_id(&target.repo_path, &worktree);

    let summary = compute_diff(&target).map_err(WalkthroughError::Git)?;
    if is_too_small(&summary) {
        return Err(WalkthroughError::TooSmall);
    }

    let ctx = repo_context(Path::new(&target.repo_path));
    let sig = diff_sig(&summary, &ctx);

    let existing = storage.load(&id).map_err(WalkthroughError::Git)?;
    if !force {
        if let Some(cached) = existing.as_ref().and_then(|r| r.walkthrough.as_ref()) {
            if cached.diff_sig == sig {
                return Ok(cached.walkthrough.clone());
            }
        }
    }

    // Only now do we need claude — a cache hit above serves without it.
    let runner = make_runner(&id)?;
    let (diff_text, degraded) = diff_payload(&target, &summary).map_err(WalkthroughError::Git)?;
    let payload = prompt::user_payload(&ctx, &diff_text, degraded);
    let system = prompt::system_prompt();
    let diff_paths: HashSet<String> = summary.files.iter().map(|f| f.path.clone()).collect();

    let mut walkthrough = generate_with_runner(runner.as_ref(), &system, &payload, &diff_paths)?;
    if degraded {
        walkthrough.degraded = true;
    }

    // Persist onto the review (preserve comments/viewed when it already exists).
    let now = chrono::Utc::now().to_rfc3339();
    let cached = CachedWalkthrough { walkthrough: walkthrough.clone(), diff_sig: sig, generated_at: now.clone() };
    let mut review = existing.unwrap_or_else(|| {
        Review::new(
            id.clone(),
            target.clone(),
            Snapshot { base_oid: String::new(), head_oid: None, captured_at: String::new() },
            now.clone(),
        )
    });
    review.target = target;
    review.walkthrough = Some(cached);
    // Best-effort: a cache-write failure must not discard a paid-for generation.
    if let Err(e) = storage.save(&review) {
        eprintln!("[delta] walkthrough cache save failed: {e}");
    }

    Ok(walkthrough)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_registry_register_and_matched_remove() {
        let r = ChildRegistry::default();
        r.register("rev1", 4242);
        assert_eq!(r.pid_of("rev1"), Some(4242));
        // a stale remove (wrong pid) leaves it
        r.remove("rev1", 9999);
        assert_eq!(r.pid_of("rev1"), Some(4242));
        // the matching remove clears it
        r.remove("rev1", 4242);
        assert_eq!(r.pid_of("rev1"), None);
    }

    #[test]
    fn child_registry_kill_absent_is_false() {
        let r = ChildRegistry::default();
        assert!(!r.kill("nope"));
    }

    #[test]
    fn claude_status_matches_resolver() {
        assert_eq!(claude_status_impl().installed, resolve_claude().is_some());
    }

    #[test]
    fn generate_persists_and_then_serves_from_cache() {
        use crate::git::model::DiffMode;
        use crate::git::test_support::*;
        use crate::storage::JsonStorage;

        let (dir, repo) = repo_with_commit();
        // Commit a base so the edits below are TRACKED — untracked files report 0
        // line-stats, which the real (committed) walkthrough path never sees.
        write(dir.path(), "a.ts", "old\n");
        write(dir.path(), "b.ts", "old\n");
        commit_all(&repo, "add a,b");
        write(dir.path(), "a.ts", &"newa\n".repeat(12));
        write(dir.path(), "b.ts", &"newb\n".repeat(12));
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };

        let good = r#"{"version":1,"title":"Two new modules","summary":"Adds a and b.","groups":[
            {"id":"g1","title":"Module A","summary":"The a module.","order":1,"importance":"core","files":[{"path":"a.ts"}],"risks":[]},
            {"id":"g2","title":"Module B","summary":"The b module.","order":2,"importance":"supporting","files":[{"path":"b.ts"}],"risks":[]}],"ignored":[]}"#.to_string();

        // Runner that yields the good JSON once; a second run() panics — proving the
        // second generate() served from cache without invoking claude.
        struct Once {
            out: std::sync::Mutex<Option<String>>,
        }
        impl ClaudeRunner for Once {
            fn run(&self, _s: &str, _i: &str) -> Result<String, WalkthroughError> {
                let body = self.out.lock().unwrap().take().expect("runner invoked twice");
                Ok(serde_json::json!({"type":"result","result": body,"is_error":false}).to_string())
            }
        }

        let g = good.clone();
        let make = move |_id: &str| -> Result<Box<dyn ClaudeRunner>, WalkthroughError> {
            Ok(Box::new(Once { out: std::sync::Mutex::new(Some(g.clone())) }))
        };
        let w1 = generate_walkthrough_impl(&storage, target.clone(), false, make).unwrap();
        assert_eq!(w1.groups.len(), 2);

        // Cache hit: make_runner must never be called (it would build a None Once and
        // panic if run). Cache check happens before make_runner.
        let make2 = |_id: &str| -> Result<Box<dyn ClaudeRunner>, WalkthroughError> {
            panic!("runner should not be built on a cache hit");
        };
        let w2 = generate_walkthrough_impl(&storage, target, false, make2).unwrap();
        assert_eq!(w2.groups.len(), 2);
    }
}

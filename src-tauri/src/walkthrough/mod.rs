// AI-guidance walkthrough backend: compute the diff, assemble a controlled stdin
// payload (bounded patch + self-read repo CLAUDE.md/docs), shell out to the local
// `claude` CLI under `--safe-mode`, then validate the JSON against the quality
// invariants. Results are cached on the review by diff signature. (#guide)
pub mod claude;
pub mod context;
pub mod model;
pub mod prompt;

use crate::walkthrough::model::ClaudeStatus;
use std::collections::HashMap;
use std::path::PathBuf;
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
}

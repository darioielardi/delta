//! Per-window filesystem watcher. When a review window opens we watch its
//! worktree and, on a debounced batch of *relevant* changes, emit `fs:changed`
//! to that window so the frontend can auto-refresh the diff. (#9)
//!
//! "Relevant" excludes gitignored paths (so `node_modules`/`target` churn never
//! fires) and `.git` object/lock noise, while still catching commits, checkouts
//! and staging via `.git/HEAD`, `.git/refs/*` and `.git/index`.
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// Live watchers keyed by window label. Dropping a watcher (on window close)
/// disconnects its channel, which ends the paired debounce thread.
#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangePayload {
    /// Repo-relative paths of changed working-tree files.
    paths: Vec<String>,
    /// True when HEAD/refs/index changed (commit, checkout, stage) — the whole
    /// diff may have shifted, so the frontend reloads everything.
    git_meta: bool,
}

const DEBOUNCE: Duration = Duration::from_millis(350);

fn build_ignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let _ = b.add(root.join(".gitignore"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Classify a changed path: `Some(Some(rel))` for a relevant working-tree file,
/// `Some(None)` for a relevant `.git` meta change, `None` to ignore.
fn classify(path: &Path, root: &Path, ig: &Gitignore) -> Option<Option<String>> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let in_git = rel
        .components()
        .next()
        .map(|c| c.as_os_str() == std::ffi::OsStr::new(".git"))
        .unwrap_or(false);
    if in_git {
        let meta = rel_str == ".git/HEAD"
            || rel_str == ".git/MERGE_HEAD"
            || rel_str == ".git/index"
            || rel_str.starts_with(".git/refs/");
        return if meta { Some(None) } else { None };
    }
    // `matched_path_or_any_parents` (not `matched`) so a file *inside* an ignored
    // directory (e.g. node_modules/x.js) is caught, not just the directory entry.
    if ig.matched_path_or_any_parents(path, path.is_dir()).is_ignore() {
        return None;
    }
    Some(Some(rel_str))
}

/// Begin watching `worktree` for the window `label`. No-op if a watcher can't be
/// created; idempotent callers should only start once per window.
pub fn start(app: &AppHandle, label: &str, worktree: &Path) {
    let Some(state) = app.try_state::<Watchers>() else {
        return;
    };
    let root = worktree.to_path_buf();
    let ig = build_ignore(&root);
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }

    let app = app.clone();
    let label_str = label.to_string();
    std::thread::spawn(move || loop {
        // Block until the first event, then coalesce a quiet window.
        let first = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => break, // watcher dropped (window closed)
        };
        let mut batch = vec![first];
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(ev) => batch.push(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut paths: Vec<String> = Vec::new();
        let mut git_meta = false;
        for ev in batch.iter().flatten() {
            for p in &ev.paths {
                match classify(p, &root, &ig) {
                    Some(Some(rel)) => {
                        if !paths.contains(&rel) {
                            paths.push(rel);
                        }
                    }
                    Some(None) => git_meta = true,
                    None => {}
                }
            }
        }
        if git_meta || !paths.is_empty() {
            let _ = app.emit_to(
                EventTarget::webview_window(label_str.as_str()),
                "fs:changed",
                ChangePayload { paths, git_meta },
            );
        }
    });

    state.0.lock().unwrap().insert(label.to_string(), watcher);
}

/// Stop watching for `label` (drops the watcher → ends its debounce thread).
pub fn stop(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<Watchers>() {
        state.0.lock().unwrap().remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_ignores_gitignored_and_git_noise() {
        let root = Path::new("/repo");
        let mut b = GitignoreBuilder::new(root);
        b.add_line(None, "node_modules/").unwrap();
        let ig = b.build().unwrap();

        // gitignored → ignored
        assert_eq!(classify(Path::new("/repo/node_modules/x.js"), root, &ig), None);
        // .git object churn → ignored
        assert_eq!(classify(Path::new("/repo/.git/objects/ab/cd"), root, &ig), None);
        // working-tree file → relevant relpath
        assert_eq!(
            classify(Path::new("/repo/src/a.ts"), root, &ig),
            Some(Some("src/a.ts".to_string()))
        );
        // .git meta → relevant, no path
        assert_eq!(classify(Path::new("/repo/.git/HEAD"), root, &ig), Some(None));
        assert_eq!(classify(Path::new("/repo/.git/refs/heads/main"), root, &ig), Some(None));
    }
}

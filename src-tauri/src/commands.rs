use crate::export::export_markdown;
use crate::git::diff::{compute_diff as engine_compute, get_file_diff as engine_file, DiffSummary, FileDiff};
use crate::git::log::{list_commits as engine_list_commits, CommitMeta};
use crate::git::model::{DiffMode, Target};
use crate::git::{open_repo, resolve_worktree};
use crate::launch::{
    cli_status as launch_cli_status, install_cli as launch_install_cli,
    list_worktrees as launch_list_worktrees, open_guide_window, open_target_window, rewatch_target,
    repo_display_name, repo_entry, CliStatus, InstallOutcome,
};
use crate::registry::model::{Registry, RepoEntry, ReviewEntry, WorktreeEntry};
use crate::review::model::{review_id, Review, Snapshot};
use crate::review::reconcile::{reconcile, ReviewSession};
use crate::storage::{JsonRegistryStore, JsonStorage, RegistryStore, Storage};
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub fn compute_diff_impl(target: Target) -> Result<DiffSummary, String> {
    engine_compute(&target)
}

pub fn get_file_diff_impl(target: Target, path: String) -> Result<FileDiff, String> {
    engine_file(&target, &path)
}

pub fn list_commits_impl(target: Target) -> Result<Vec<CommitMeta>, String> {
    engine_list_commits(&target)
}

fn reviews_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("reviews"))
}

pub fn open_review_impl(storage: &dyn Storage, input: Target) -> Result<ReviewSession, String> {
    let repo = open_repo(&input.repo_path)?;
    let worktree = resolve_worktree(&repo)?;
    let mut target = input;
    target.worktree = Some(worktree.clone());
    let id = review_id(&target.repo_path, &worktree);

    let review = match storage.load(&id)? {
        // Trust the freshly-resolved target (mode / repo / worktree); only the
        // user's comments + viewed state carry over. A persisted review must
        // never silently override the requested mode with a stale one.
        Some(mut r) => {
            r.target = target;
            r
        }
        None => Review::new(
            id,
            target,
            Snapshot { base_oid: String::new(), head_oid: None, captured_at: String::new() },
            chrono::Utc::now().to_rfc3339(),
        ),
    };
    let session = reconcile(review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn refresh_review_impl(storage: &dyn Storage, review: Review) -> Result<ReviewSession, String> {
    let session = reconcile(review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn save_review_impl(storage: &dyn Storage, review: Review) -> Result<(), String> {
    storage.save(&review)
}

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("registry.json"))
}

fn reg_store(app: &tauri::AppHandle) -> Result<JsonRegistryStore, String> {
    Ok(JsonRegistryStore::new(registry_path(app)?, reviews_dir(app)?))
}

/// True when a recent review already covers this worktree (so the picker lists it
/// under "recent", not "other worktrees"). Matches by worktree path, or by repo
/// name + branch (a linked worktree resolves to a different path than the review's).
pub fn worktree_has_review(w: &WorktreeEntry, repo_name: &str, recents: &[ReviewEntry]) -> bool {
    recents.iter().any(|r| {
        r.target.repo_path == w.path
            || (r.repo_name == repo_name && r.target.worktree.as_deref() == Some(w.branch.as_str()))
    })
}

/// Upsert repo + review entry with a fresh file_count (open/refresh path). Non-fatal.
fn sync_registry_after_open(reg_store: &dyn RegistryStore, review: &Review, file_count: u32) {
    let result = (|| -> Result<(), String> {
        let mut reg = reg_store.load()?;
        if let Ok(entry) = repo_entry(&review.target.repo_path) {
            reg.upsert_repo(entry);
        }
        let name = repo_display_name(&review.target.repo_path);
        reg.upsert_review(ReviewEntry::from_review(review, file_count, name));
        reg_store.save(&reg)
    })();
    if let Err(e) = result {
        eprintln!("[delta] registry sync (open) failed: {e}");
    }
}

/// Update counts, preserving the prior file_count (autosave path). Non-fatal.
fn sync_registry_after_save(reg_store: &dyn RegistryStore, review: &Review) {
    let result = (|| -> Result<(), String> {
        let mut reg = reg_store.load()?;
        let prior_file_count = reg
            .reviews
            .iter()
            .find(|e| e.id == review.id)
            .map(|e| e.file_count)
            .unwrap_or(0);
        let name = repo_display_name(&review.target.repo_path);
        reg.upsert_review(ReviewEntry::from_review(review, prior_file_count, name));
        reg_store.save(&reg)
    })();
    if let Err(e) = result {
        eprintln!("[delta] registry sync (save) failed: {e}");
    }
}

// Registry-aware impls (used by the #[tauri::command] wrappers). The Plan 2
// impls (open_review_impl, etc.) stay for their existing unit tests.
pub fn open_review_impl_with_registry(storage: &dyn Storage, reg_store: &dyn RegistryStore, input: Target) -> Result<ReviewSession, String> {
    let mut session = open_review_impl(storage, input)?;
    session.repo_name = repo_display_name(&session.review.target.repo_path);
    sync_registry_after_open(reg_store, &session.review, session.summary.files.len() as u32);
    Ok(session)
}

pub fn refresh_review_impl_with_registry(storage: &dyn Storage, reg_store: &dyn RegistryStore, review: Review) -> Result<ReviewSession, String> {
    let mut session = refresh_review_impl(storage, review)?;
    session.repo_name = repo_display_name(&session.review.target.repo_path);
    sync_registry_after_open(reg_store, &session.review, session.summary.files.len() as u32);
    Ok(session)
}

pub fn save_review_impl_with_registry(storage: &dyn Storage, reg_store: &dyn RegistryStore, review: Review) -> Result<(), String> {
    save_review_impl(storage, review.clone())?;
    sync_registry_after_save(reg_store, &review);
    Ok(())
}

pub fn delete_review_impl(storage: &dyn Storage, reg_store: &dyn RegistryStore, id: &str) -> Result<(), String> {
    storage.delete(id)?;
    let mut reg = reg_store.load()?;
    reg.remove_review(id);
    reg_store.save(&reg)
}

#[tauri::command]
pub async fn compute_diff(target: Target) -> Result<DiffSummary, String> {
    tauri::async_runtime::spawn_blocking(move || compute_diff_impl(target))
        .await
        .map_err(|e| format!("compute_diff task: {e}"))?
}

#[tauri::command]
pub async fn get_file_diff(target: Target, path: String) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || get_file_diff_impl(target, path))
        .await
        .map_err(|e| format!("get_file_diff task: {e}"))?
}

#[tauri::command]
pub async fn list_commits(target: Target) -> Result<Vec<CommitMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || list_commits_impl(target))
        .await
        .map_err(|e| format!("list_commits task: {e}"))?
}

#[tauri::command]
pub async fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        open_review_impl_with_registry(&storage, &reg, target)
    })
    .await
    .map_err(|e| format!("open_review task: {e}"))?
}

#[tauri::command]
pub async fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        refresh_review_impl_with_registry(&storage, &reg, review)
    })
    .await
    .map_err(|e| format!("refresh_review task: {e}"))?
}

#[tauri::command]
pub fn save_review(app: tauri::AppHandle, review: Review) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    save_review_impl_with_registry(&storage, &reg_store(&app)?, review)
}

#[tauri::command]
pub fn delete_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    delete_review_impl(&storage, &reg_store(&app)?, &id)?;
    if let Some(w) = app.get_webview_window(&format!("review-{id}")) {
        let _ = w.close();
    }
    Ok(())
}

#[tauri::command]
pub fn export_review(review: Review) -> Result<String, String> {
    Ok(export_markdown(&review))
}

#[tauri::command]
pub fn list_registry(app: tauri::AppHandle) -> Result<Registry, String> {
    let mut reg = reg_store(&app)?.load()?;
    // Supplied on read only (never persisted) so the UI can render ~-paths.
    reg.home = std::env::var("HOME").ok();
    Ok(reg)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerWorktree {
    #[serde(flatten)]
    pub worktree: WorktreeEntry,
    pub repo_name: String,
    pub repo_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerData {
    pub recents: Vec<ReviewEntry>,
    pub worktrees: Vec<PickerWorktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

/// Recents + the live, currently-checked-out worktrees of every known repo, with
/// worktrees already covered by a review removed (they show under recents).
pub fn list_picker_impl(reg_store: &dyn RegistryStore, home: Option<String>) -> Result<PickerData, String> {
    let reg = reg_store.load()?;
    let recents = reg.reviews.clone();
    let mut worktrees = Vec::new();
    for repo in &reg.repos {
        // Best-effort: a repo whose worktrees can't be listed (moved/deleted) is skipped.
        let wts = launch_list_worktrees(&repo.root).unwrap_or_default();
        for w in wts {
            if worktree_has_review(&w, &repo.name, &recents) {
                continue;
            }
            worktrees.push(PickerWorktree { worktree: w, repo_name: repo.name.clone(), repo_id: repo.id.clone() });
        }
    }
    Ok(PickerData { recents, worktrees, home })
}

// Async so Tauri runs the git enumeration OFF the main thread. A synchronous command
// blocks the main thread for the whole scan, freezing the UI on every open — which is
// the picker's open latency, paid per call regardless of the frontend cache.
#[tauri::command]
pub async fn list_picker(app: tauri::AppHandle) -> Result<PickerData, String> {
    let home = std::env::var("HOME").ok();
    let store = reg_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_picker_impl(&store, home))
        .await
        .map_err(|e| format!("list_picker task failed: {e}"))?
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeEntry>, String> {
    launch_list_worktrees(&repo_path)
}

#[tauri::command]
pub async fn import_repo(app: tauri::AppHandle) -> Result<Option<RepoEntry>, String> {
    // The native folder dialog blocks on a sync channel and must run OFF the main
    // thread — calling it from a synchronous command (which runs on the main thread)
    // freezes the event loop (the app beachballs). Run it on the blocking pool so the
    // main thread stays free to drive the dialog.
    let dialog_app = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(folder) = folder else {
        return Ok(None);
    };
    let repo_path = folder
        .into_path()
        .map_err(|e| format!("dialog path: {e}"))?
        .display()
        .to_string();
    // Reject a non-repo selection with a clean, user-facing message (the UI shows it in
    // a modal) rather than the raw git2 error repo_entry would surface. discover walks
    // up, so picking a subdir of a repo still imports that repo.
    if open_repo(&repo_path).is_err() {
        return Err(format!("{repo_path} is not a git repository."));
    }
    let entry = repo_entry(&repo_path)?;
    let store = reg_store(&app)?;
    let mut reg = store.load()?;
    reg.upsert_repo(entry.clone());
    store.save(&reg)?;
    Ok(Some(entry))
}

#[tauri::command]
pub fn open_target(app: tauri::AppHandle, repo_path: String, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    open_target_window(&app, &repo_path, mode, base).map(|_| ())
}

/// Re-point the calling window's fs watcher at `repo_path`'s worktree — used when
/// a review window navigates in place ("replace current" picker mode). (#replace)
#[tauri::command]
pub fn rewatch_window(window: tauri::WebviewWindow, app: tauri::AppHandle, repo_path: String) -> Result<(), String> {
    rewatch_target(&app, window.label(), &repo_path)
}

// Dev-only affordance behind the header "Walkthrough" button: open the Guide
// experience on mock fixtures in its own window. (#guide-dev)
#[tauri::command]
pub fn open_guide(app: tauri::AppHandle) -> Result<(), String> {
    open_guide_window(&app)
}

#[tauri::command]
pub fn install_cli() -> Result<InstallOutcome, String> {
    launch_install_cli()
}

#[tauri::command]
pub fn cli_status() -> CliStatus {
    launch_cli_status()
}

// "Open in your editor" (#editor). Each curated editor maps to a CLI; where the
// CLI supports it, `line` jumps to that line. Pure so it's unit-testable.
fn editor_invocation(editor: &str, path: &str, line: Option<u32>) -> Result<(&'static str, Vec<String>), String> {
    let prog = match editor {
        "vscode" => "code",
        "cursor" => "cursor",
        "zed" => "zed",
        "sublime" => "subl",
        "intellij" => "idea",
        other => return Err(format!("Unknown editor: {other}")),
    };
    let args: Vec<String> = match (editor, line) {
        // VS Code / Cursor: `-g <path>:<line>` opens and goes to the line.
        ("vscode", Some(l)) | ("cursor", Some(l)) => vec!["-g".into(), format!("{path}:{l}")],
        // Zed / Sublime accept `<path>:<line>` directly.
        ("zed", Some(l)) | ("sublime", Some(l)) => vec![format!("{path}:{l}")],
        ("intellij", Some(l)) => vec!["--line".into(), l.to_string(), path.into()],
        _ => vec![path.into()],
    };
    Ok((prog, args))
}

/// Resolve an editor CLI to an absolute path. A GUI-launched macOS app inherits a
/// minimal PATH, so search the usual install dirs on top of $PATH.
fn resolve_program(prog: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/bin"));
        dirs.push(PathBuf::from(&home).join("bin"));
    }
    dirs.into_iter().map(|d| d.join(prog)).find(|c| c.is_file())
}

#[tauri::command]
pub fn open_in_editor(editor: String, repo_path: String, file: Option<String>, line: Option<u32>) -> Result<(), String> {
    // file omitted → open the repo/worktree root; otherwise join it onto the root.
    let target = match file {
        Some(f) => PathBuf::from(&repo_path).join(f),
        None => PathBuf::from(&repo_path),
    };
    let (prog, args) = editor_invocation(&editor, &target.to_string_lossy(), line)?;
    let resolved = resolve_program(prog).ok_or_else(|| {
        format!("Couldn't find the '{prog}' command on your PATH. Install {editor}'s shell command and try again.")
    })?;
    std::process::Command::new(resolved)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("launch {editor}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::review::model::{Comment, CommentScope};
    use crate::storage::{JsonRegistryStore, RegistryStore};

    fn stores(dir: &std::path::Path) -> (JsonStorage, JsonRegistryStore) {
        let reviews = dir.join("reviews");
        (JsonStorage::new(reviews.clone()), JsonRegistryStore::new(dir.join("registry.json"), reviews))
    }

    #[test]
    fn worktree_has_review_matches_by_path_or_repo_and_branch() {
        let recents = vec![ReviewEntry {
            id: "x".into(),
            repo_name: "demo".into(),
            target: Target { repo_path: "/r/demo".into(), worktree: Some("feat/a".into()), mode: DiffMode::AllChanges, base: None, commit: None },
            last_opened_at: "t".into(),
            comment_count: 0, stale_count: 0, resolved_count: 0, viewed_count: 0, file_count: 1,
        }];
        let wt = |path: &str, branch: &str| WorktreeEntry { path: path.into(), branch: branch.into(), is_main: false, last_commit_at: None, dirty: false };
        // same path → covered
        assert!(worktree_has_review(&wt("/r/demo", "feat/a"), "demo", &recents));
        // same repo + branch, different path (linked worktree) → covered
        assert!(worktree_has_review(&wt("/r/demo-a", "feat/a"), "demo", &recents));
        // different branch → not covered
        assert!(!worktree_has_review(&wt("/r/demo-b", "feat/b"), "demo", &recents));
        // different repo (different path + name) → not covered, even on a same-named branch
        assert!(!worktree_has_review(&wt("/r/other", "feat/a"), "other", &recents));
    }

    #[test]
    fn list_picker_returns_recents_and_unreviewed_worktrees() {
        let (dir, repo) = repo_with_commit(); // main worktree on "main"
        add_worktree(&repo, dir.path(), "demo-feat", "feat/a"); // linked worktree "feat/a"
        let root = dir.path().to_str().unwrap().to_string();

        let store_dir = tempfile::TempDir::new().unwrap();
        let (_storage, reg_store) = stores(store_dir.path());
        let entry = repo_entry(&root).unwrap();
        let repo_name = entry.name.clone();
        let mut reg = reg_store.load().unwrap();
        reg.upsert_repo(entry);
        reg.upsert_review(ReviewEntry {
            id: "rev1".into(),
            repo_name: repo_name.clone(),
            target: Target { repo_path: root.clone(), worktree: Some("main".into()), mode: DiffMode::AllChanges, base: None, commit: None },
            last_opened_at: "t".into(),
            comment_count: 0, stale_count: 0, resolved_count: 0, viewed_count: 0, file_count: 1,
        });
        reg_store.save(&reg).unwrap();

        let data = list_picker_impl(&reg_store, Some("/Users/me".into())).unwrap();
        assert_eq!(data.recents.len(), 1);
        // "main" is covered by a review → only "feat/a" appears under other worktrees.
        let branches: Vec<&str> = data.worktrees.iter().map(|w| w.worktree.branch.as_str()).collect();
        assert_eq!(branches, vec!["feat/a"]);
        assert_eq!(data.worktrees[0].repo_name, repo_name);
        assert_eq!(data.home.as_deref(), Some("/Users/me"));
    }

    #[test]
    fn compute_diff_command_returns_summary() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "a\nb\n");
        let summary = compute_diff_impl(Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        })
        .unwrap();
        assert_eq!(summary.files.len(), 1);
    }

    #[test]
    fn open_review_impl_creates_persists_and_reanchors() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));

        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl(&storage, target).unwrap();

        assert!(session.summary.files.iter().any(|f| f.path == "file.txt"));
        assert_eq!(session.review.target.worktree.as_deref(), Some("main"));
        // persisted under the deterministic id
        let loaded = storage.load(&session.review.id).unwrap();
        assert!(loaded.is_some());
    }

    #[test]
    fn save_review_impl_persists() {
        use crate::storage::{JsonStorage, Storage};

        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let now = chrono::Utc::now().to_rfc3339();

        let target = Target { repo_path: "/repo".into(), worktree: Some("main".into()), mode: DiffMode::Uncommitted, base: None, commit: None };
        let snapshot = Snapshot { base_oid: "abc123".into(), head_oid: None, captured_at: now.clone() };
        let review = Review::new("0123456789abcdef".into(), target, snapshot, now);

        save_review_impl(&storage, review.clone()).unwrap();
        let loaded = storage.load(&review.id).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().id, "0123456789abcdef");
    }

    #[test]
    fn refresh_review_impl_reconciles_and_persists() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));

        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl(&storage, target).unwrap();

        let refreshed = refresh_review_impl(&storage, session.review.clone()).unwrap();
        assert!(!refreshed.summary.files.is_empty());
        let persisted = storage.load(&session.review.id).unwrap();
        assert!(persisted.is_some());
    }

    #[test]
    fn open_review_populates_registry_with_file_count() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };

        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg.reviews.iter().find(|e| e.id == session.review.id).expect("review entry");
        assert_eq!(entry.file_count, session.summary.files.len() as u32);
        assert!(reg.repos.iter().any(|r| !r.worktrees.is_empty()));
    }

    #[test]
    fn save_review_preserves_file_count() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();
        let original_file_count = session.summary.files.len() as u32;

        let mut review = session.review.clone();
        review.comments.push(Comment { id: "c1".into(), scope: CommentScope::Line, anchor: None, body: "hi".into(), stale: false, resolved: false, commit: None, created_at: "t".into(), updated_at: "t".into() });
        save_review_impl_with_registry(&storage, &reg_store, review).unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg.reviews.iter().find(|e| e.id == session.review.id).unwrap();
        assert_eq!(entry.file_count, original_file_count, "file_count preserved across save");
        assert_eq!(entry.comment_count, 1);
    }

    #[test]
    fn editor_invocation_builds_line_aware_args() {
        assert_eq!(
            editor_invocation("vscode", "/a/b.ts", Some(42)).unwrap(),
            ("code", vec!["-g".to_string(), "/a/b.ts:42".to_string()])
        );
        assert_eq!(
            editor_invocation("zed", "/a/b.ts", Some(7)).unwrap(),
            ("zed", vec!["/a/b.ts:7".to_string()])
        );
        assert_eq!(
            editor_invocation("intellij", "/a/b.ts", Some(3)).unwrap(),
            ("idea", vec!["--line".to_string(), "3".to_string(), "/a/b.ts".to_string()])
        );
        // No line → just the path (e.g. opening the repo root).
        assert_eq!(
            editor_invocation("vscode", "/repo", None).unwrap(),
            ("code", vec!["/repo".to_string()])
        );
        assert!(editor_invocation("emacs", "/a", None).is_err());
    }

    #[test]
    fn delete_review_removes_file_and_entry() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();

        delete_review_impl(&storage, &reg_store, &session.review.id).unwrap();

        assert!(storage.load(&session.review.id).unwrap().is_none());
        assert!(reg_store.load().unwrap().reviews.iter().all(|e| e.id != session.review.id));
    }
}

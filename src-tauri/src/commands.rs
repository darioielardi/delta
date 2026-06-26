use crate::export::export_markdown;
use crate::git::diff::{compute_diff as engine_compute, get_file_diff as engine_file, DiffSummary, FileDiff};
use crate::git::model::{DiffMode, Target};
use crate::git::{open_repo, resolve_worktree};
use crate::launch::{
    install_cli as launch_install_cli, list_worktrees as launch_list_worktrees, open_target_window,
    repo_display_name, repo_entry, InstallOutcome,
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
pub fn compute_diff(target: Target) -> Result<DiffSummary, String> {
    compute_diff_impl(target)
}

#[tauri::command]
pub fn get_file_diff(target: Target, path: String) -> Result<FileDiff, String> {
    get_file_diff_impl(target, path)
}

#[tauri::command]
pub fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    open_review_impl_with_registry(&storage, &reg_store(&app)?, target)
}

#[tauri::command]
pub fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    refresh_review_impl_with_registry(&storage, &reg_store(&app)?, review)
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
    reg_store(&app)?.load()
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
    let entry = repo_entry(&repo_path)?;
    let store = reg_store(&app)?;
    let mut reg = store.load()?;
    reg.upsert_repo(entry.clone());
    store.save(&reg)?;
    Ok(Some(entry))
}

#[tauri::command]
pub fn open_target(app: tauri::AppHandle, repo_path: String, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    open_target_window(&app, &repo_path, mode, base)
}

#[tauri::command]
pub fn install_cli() -> Result<InstallOutcome, String> {
    launch_install_cli()
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
    fn compute_diff_command_returns_summary() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "a\nb\n");
        let summary = compute_diff_impl(Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
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

        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
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

        let target = Target { repo_path: "/repo".into(), worktree: Some("main".into()), mode: DiffMode::Uncommitted, base: None };
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

        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
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
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };

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
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();
        let original_file_count = session.summary.files.len() as u32;

        let mut review = session.review.clone();
        review.comments.push(Comment { id: "c1".into(), scope: CommentScope::Line, anchor: None, body: "hi".into(), stale: false, created_at: "t".into(), updated_at: "t".into() });
        save_review_impl_with_registry(&storage, &reg_store, review).unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg.reviews.iter().find(|e| e.id == session.review.id).unwrap();
        assert_eq!(entry.file_count, original_file_count, "file_count preserved across save");
        assert_eq!(entry.comment_count, 1);
    }

    #[test]
    fn delete_review_removes_file_and_entry() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();

        delete_review_impl(&storage, &reg_store, &session.review.id).unwrap();

        assert!(storage.load(&session.review.id).unwrap().is_none());
        assert!(reg_store.load().unwrap().reviews.iter().all(|e| e.id != session.review.id));
    }
}

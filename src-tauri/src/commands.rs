use crate::export::export_markdown;
use crate::git::diff::{compute_diff as engine_compute, get_file_diff as engine_file, DiffSummary, FileDiff};
use crate::git::model::Target;
use crate::git::{open_repo, resolve_worktree};
use crate::review::model::{review_id, Review, Snapshot};
use crate::review::reconcile::{reconcile, ReviewSession};
use crate::storage::{JsonStorage, Storage};
use std::path::PathBuf;
use tauri::Manager;

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
    let id = review_id(&target.repo_path, &worktree, target.mode);

    let review = match storage.load(&id)? {
        Some(r) => r,
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
    open_review_impl(&storage, target)
}

#[tauri::command]
pub fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    refresh_review_impl(&storage, review)
}

#[tauri::command]
pub fn save_review(app: tauri::AppHandle, review: Review) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    storage.save(&review)
}

#[tauri::command]
pub fn export_review(review: Review) -> Result<String, String> {
    Ok(export_markdown(&review))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

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
}

use crate::git::diff::{compute_diff as engine_compute, get_file_diff as engine_file, DiffSummary, FileDiff};
use crate::git::model::Target;

pub fn compute_diff_impl(target: Target) -> Result<DiffSummary, String> {
    engine_compute(&target)
}

pub fn get_file_diff_impl(target: Target, path: String) -> Result<FileDiff, String> {
    engine_file(&target, &path)
}

#[tauri::command]
pub fn compute_diff(target: Target) -> Result<DiffSummary, String> {
    compute_diff_impl(target)
}

#[tauri::command]
pub fn get_file_diff(target: Target, path: String) -> Result<FileDiff, String> {
    get_file_diff_impl(target, path)
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
}

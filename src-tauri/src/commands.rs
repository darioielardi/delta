use crate::export::export_markdown;
use crate::git::cache::DiffCache;
use crate::git::diff::{DiffSummary, FileDiff};
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
use crate::review::reconcile::{adopt_persisted_viewed_hashes, reconcile, restore_persisted_comments, stamp_viewed_baselines, ReviewSession};
use crate::storage::{JsonRegistryStore, JsonStorage, RegistryStore, Storage};
use crate::walkthrough::claude::{ClaudeRunner, RealClaude};
use crate::walkthrough::model::{ClaudeStatus, Walkthrough, WalkthroughError};
use crate::walkthrough::{claude_status_impl, generate_walkthrough_impl, resolve_claude, ChildRegistry};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Process-wide one-shot latch for the self-updater. `useUpdater` runs per
/// window (App mounts in each), so two windows open at once could otherwise
/// both `check()` + `downloadAndInstall()` and race on replacing the .app.
/// The first window to call this wins; the rest skip for the process lifetime.
/// (#updater-race)
#[derive(Default)]
pub struct UpdaterGate(AtomicBool);

#[tauri::command]
pub fn updater_try_acquire(gate: tauri::State<'_, UpdaterGate>) -> bool {
    gate.0
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// True unless telemetry is disabled by build or environment. This reports only
/// what the frontend cannot see (the debug/release flag and process env); the
/// user's Settings toggle is a separate, frontend-only check. Debug builds have
/// no analytics plugin registered, so this is always false there.
#[tauri::command]
pub fn telemetry_allowed() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    telemetry_allowed_from_env(
        std::env::var("DO_NOT_TRACK").ok().as_deref(),
        std::env::var("DELTA_TELEMETRY").ok().as_deref(),
    )
}

/// Pure decision: `DO_NOT_TRACK=1|true` (Console Do Not Track standard) or
/// `DELTA_TELEMETRY=0|false` disables; anything else is allowed.
pub(crate) fn telemetry_allowed_from_env(
    do_not_track: Option<&str>,
    delta_telemetry: Option<&str>,
) -> bool {
    let dnt = do_not_track
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if dnt {
        return false;
    }
    let disabled = delta_telemetry
        .map(|v| v == "0" || v.eq_ignore_ascii_case("false"))
        .unwrap_or(false);
    !disabled
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

pub fn refresh_review_impl(storage: &dyn Storage, mut review: Review) -> Result<ReviewSession, String> {
    // The FE's in-memory viewed entries may still carry empty hashes from a
    // just-made toggle; save_review already stamped the real baselines to disk.
    // Adopt them so a file changed since it was viewed is correctly un-viewed here.
    if let Ok(Some(persisted)) = storage.load(&review.id) {
        adopt_persisted_viewed_hashes(&mut review, &persisted);
        restore_persisted_comments(&mut review, &persisted);
    }
    let session = reconcile(review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn save_review_impl(cache: &DiffCache, storage: &dyn Storage, mut review: Review) -> Result<(), String> {
    // Stamp a content baseline onto freshly-toggled viewed entries now, while the
    // files are still at the version the user saw — see stamp_viewed_baselines.
    // Served from the diff cache (a map read), not a fresh whole-repo diff per entry.
    stamp_viewed_baselines(cache, &mut review);
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

pub fn save_review_impl_with_registry(cache: &DiffCache, storage: &dyn Storage, reg_store: &dyn RegistryStore, review: Review) -> Result<(), String> {
    save_review_impl(cache, storage, review.clone())?;
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
pub async fn compute_diff(target: Target, cache: tauri::State<'_, DiffCache>) -> Result<DiffSummary, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.summary(&target))
        .await
        .map_err(|e| format!("compute_diff task: {e}"))?
}

#[tauri::command]
pub async fn get_file_diff(target: Target, path: String, cache: tauri::State<'_, DiffCache>) -> Result<FileDiff, String> {
    // Served from the memoized snapshot — the whole-repo diff runs once per snapshot,
    // not once per file (the large-review perf fix). (#perf)
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.file(&target, &path))
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
    // A refresh means "recompute against the current state", so drop any memoized
    // diff snapshot for this worktree — the window's refetch then rebuilds fresh.
    // Covers a manual Refresh and one racing the fs watcher's debounce. (#perf)
    app.state::<DiffCache>().invalidate(&review.target.repo_path);
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
pub async fn save_review(app: tauri::AppHandle, review: Review, cache: tauri::State<'_, DiffCache>) -> Result<(), String> {
    // Async + spawn_blocking (like the diff commands) so persistence never runs on
    // the main thread — a sync command here froze the UI on every comment/viewed save.
    let cache = cache.inner().clone();
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        save_review_impl_with_registry(&cache, &storage, &reg, review)
    })
    .await
    .map_err(|e| format!("save_review task: {e}"))?
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

// AI walkthrough: presence gate, generation, cancellation. (#guide)
#[tauri::command]
pub fn claude_status() -> ClaudeStatus {
    claude_status_impl()
}

#[tauri::command]
pub async fn generate_walkthrough(
    app: tauri::AppHandle,
    registry: tauri::State<'_, ChildRegistry>,
    target: Target,
    force: Option<bool>,
) -> Result<Walkthrough, String> {
    let reviews = reviews_dir(&app)?;
    let registry = registry.inner().clone();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews);
        // The runner is built only on a cache miss; it registers the child PID under
        // the review id so `cancel_walkthrough` can kill it.
        let make_runner = move |review_id: &str| -> Result<Box<dyn ClaudeRunner>, WalkthroughError> {
            let path = resolve_claude().ok_or(WalkthroughError::NotInstalled)?;
            Ok(Box::new(RealClaude::new(path, registry, review_id.to_string())))
        };
        generate_walkthrough_impl(&storage, target, force, make_runner).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("generate_walkthrough task: {e}"))?
}

#[tauri::command]
pub fn cancel_walkthrough(registry: tauri::State<'_, ChildRegistry>, review_id: String) -> Result<(), String> {
    registry.kill(&review_id);
    Ok(())
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
        // The command serves the summary from the DiffCache (same path the IPC uses).
        let summary = DiffCache::default()
            .summary(&Target {
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

        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();
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
    fn refresh_keeps_persisted_comments_when_frontend_copy_is_stale() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };

        let note = |id: &str, body: &str| Comment {
            id: id.into(), scope: CommentScope::General, anchor: None, body: body.into(),
            stale: false, resolved: false, commit: None, created_at: "t".into(), updated_at: "t".into(),
        };
        let ids = |cs: &[Comment]| cs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

        // Two comments are created and persisted — the on-disk review is the source of truth.
        let mut review = open_review_impl(&storage, target).unwrap().review;
        review.comments = vec![note("c1", "first"), note("c2", "second")];
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // The frontend hands refresh a STALE copy missing the second comment — its
        // reviewRef lagged a just-added comment. A refresh (fired on any fs event)
        // must not persist this reduced set and drop the comment.
        let mut stale = review.clone();
        stale.comments = vec![note("c1", "first")];

        let refreshed = refresh_review_impl(&storage, stale).unwrap();

        assert_eq!(ids(&refreshed.review.comments), vec!["c1", "c2"], "refresh must not drop a persisted comment missing from a stale FE copy");
        let persisted = storage.load(&review.id).unwrap().unwrap();
        assert_eq!(ids(&persisted.comments), vec!["c1", "c2"], "the on-disk review must still hold both comments after refresh");
    }

    #[test]
    fn refresh_keeps_file_scoped_comments_and_marks_gone_ones_stale_not_dropped() {
        use crate::review::model::{Anchor, Side};
        use crate::storage::{JsonStorage, Storage};

        // file.txt is in the diff; other.txt is not touched, so it's absent from it.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };

        // A file-scoped comment: an anchor with a file + side but no line/snippet.
        let file_note = |id: &str, file: &str| Comment {
            id: id.into(),
            scope: CommentScope::File,
            anchor: Some(Anchor { file: file.into(), side: Side::New, start_line: None, end_line: None, snippet: None }),
            body: "note".into(), stale: false, resolved: false, commit: None,
            created_at: "t".into(), updated_at: "t".into(),
        };
        let ids = |cs: &[Comment]| cs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

        let mut review = open_review_impl(&storage, target).unwrap().review;
        review.comments = vec![file_note("in-diff", "file.txt"), file_note("gone", "other.txt")];
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // Stale FE copy dropped both file-scoped comments.
        let mut stale = review.clone();
        stale.comments = vec![];

        let refreshed = refresh_review_impl(&storage, stale).unwrap();

        // Both survive on disk; the one whose file left the diff is flagged stale, not removed.
        assert_eq!(ids(&refreshed.review.comments), vec!["in-diff", "gone"], "file-scoped comments must not be dropped by a refresh");
        let by_id = |id: &str| refreshed.review.comments.iter().find(|c| c.id == id).unwrap();
        assert!(!by_id("in-diff").stale, "a file-scoped comment on a file still in the diff stays fresh");
        assert!(by_id("gone").stale, "a file-scoped comment whose file left the diff is marked stale — but kept");
        assert_eq!(storage.load(&review.id).unwrap().unwrap().comments.len(), 2, "both file-scoped comments persist");
    }

    #[test]
    fn save_stamps_empty_viewed_baseline_before_persisting() {
        use crate::review::model::ViewedEntry;
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl(&storage, target).unwrap();
        let mut review = session.review;

        // The FE toggles "viewed" with an empty hash (it doesn't compute the baseline).
        review.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: String::new() });
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // Save must have stamped the baseline from the file's current content.
        let persisted = storage.load(&review.id).unwrap().unwrap();
        assert!(!persisted.viewed[0].diff_hash.is_empty(), "save must stamp the baseline hash before persisting");
    }

    #[test]
    fn refresh_unviews_a_file_that_changed_after_being_marked_viewed() {
        use crate::review::model::ViewedEntry;
        use crate::storage::JsonStorage;

        // file.txt is in the diff at V1 — the version the user reviews.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nV1\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None };
        let session = open_review_impl(&storage, target).unwrap();
        let mut review = session.review;

        // User marks file.txt viewed. The FE persists an entry with an empty hash;
        // save runs immediately, while the file is still at V1.
        review.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: String::new() });
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // The file changes to V2 before the next refresh (e.g. an agent edits it).
        write(dir.path(), "file.txt", "line1\nV2\nline2\n");

        // Refresh reconciles the review the FE holds in memory — which still carries
        // the empty hash. It must still drop the viewed entry, because the file
        // changed since the user marked it viewed.
        let refreshed = refresh_review_impl(&storage, review).unwrap();
        assert_eq!(refreshed.review.viewed.len(), 0, "a file changed after being viewed must be un-viewed on refresh");
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
        save_review_impl_with_registry(&DiffCache::default(), &storage, &reg_store, review).unwrap();

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

#[cfg(test)]
mod telemetry_tests {
    use super::telemetry_allowed_from_env;

    #[test]
    fn allowed_by_default() {
        assert!(telemetry_allowed_from_env(None, None));
    }

    #[test]
    fn do_not_track_disables() {
        assert!(!telemetry_allowed_from_env(Some("1"), None));
        assert!(!telemetry_allowed_from_env(Some("true"), None));
        assert!(!telemetry_allowed_from_env(Some("TRUE"), None));
    }

    #[test]
    fn do_not_track_zero_is_not_opt_out() {
        assert!(telemetry_allowed_from_env(Some("0"), None));
    }

    #[test]
    fn delta_telemetry_off_disables() {
        assert!(!telemetry_allowed_from_env(None, Some("0")));
        assert!(!telemetry_allowed_from_env(None, Some("false")));
    }

    #[test]
    fn delta_telemetry_on_stays_enabled() {
        assert!(telemetry_allowed_from_env(None, Some("1")));
    }
}

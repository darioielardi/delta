use crate::git::model::DiffMode;
use crate::git::{open_repo, resolve_base, resolve_worktree};
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use crate::review::model::review_id;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The repo/worktree path to open. A bare invocation (no path arg) resolves to
    /// the cwd; whether that opens a review or falls back to Home is a downstream
    /// repo-validity check (see `route_launch`).
    pub repo_path: PathBuf,
    pub mode: DiffMode,
}

/// Pure CLI parsing. `args` excludes the binary name. No filesystem access.
pub fn parse_launch(args: &[String], cwd: &Path) -> Launch {
    let mut mode = DiffMode::AllChanges;
    let mut path_token: Option<&str> = None;
    for arg in args {
        match arg.as_str() {
            "--uncommitted" => mode = DiffMode::Uncommitted,
            "--last-commit" => mode = DiffMode::LastCommit,
            "--branch" => mode = DiffMode::BranchVsBase,
            other if !other.starts_with("--") && path_token.is_none() => path_token = Some(other),
            _ => {}
        }
    }
    // A bare invocation (no path arg) or "." resolves to the cwd, so `delta` inside
    // a repo opens that worktree; a non-repo path falls back to Home downstream. (#9)
    let repo_path = match path_token {
        None | Some(".") => cwd.to_path_buf(),
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => cwd.join(p),
    };
    Launch { repo_path, mode }
}

/// HEAD commit time (RFC3339) + dirty flag for an open worktree repo handle.
/// Both are best-effort — failures degrade to (None, false) rather than erroring
/// the whole listing.
fn worktree_meta(repo: &git2::Repository) -> (Option<String>, bool) {
    let last_commit_at = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| chrono::DateTime::from_timestamp(c.time().seconds(), 0))
        .map(|dt| dt.to_rfc3339());
    // The dirty flag needs a full `git status` scan (working-tree walk incl. untracked)
    // per worktree — the dominant cost when a repo has dozens of worktrees. Dropped
    // from the hot path; the picker shows worktrees without an uncommitted marker.
    (last_commit_at, false)
}

/// Open a linked worktree and read its display metadata. Each call uses its own
/// `Repository` handle, so this is safe to run on a worker thread.
fn linked_worktree_entry(path: &Path) -> Option<WorktreeEntry> {
    let wt_repo = git2::Repository::open(path).ok()?;
    let branch = resolve_worktree(&wt_repo).unwrap_or_else(|_| "(detached)".into());
    let (last_commit_at, dirty) = worktree_meta(&wt_repo);
    Some(WorktreeEntry {
        path: path.display().to_string(),
        branch,
        is_main: false,
        last_commit_at,
        dirty,
    })
}

/// All checked-out worktrees of the repo: the main workdir + any linked worktrees.
/// The per-worktree metadata (HEAD time + dirty status) is the slow part — a
/// `git status` scan each — so linked worktrees are opened and scanned in parallel
/// batches. A repo with dozens of worktrees would otherwise take hundreds of ms.
pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let repo = open_repo(repo_path)?;
    let mut out = Vec::new();
    if let Some(wd) = repo.workdir() {
        let (last_commit_at, dirty) = worktree_meta(&repo);
        out.push(WorktreeEntry {
            path: wd.display().to_string(),
            branch: resolve_worktree(&repo)?,
            is_main: true,
            last_commit_at,
            dirty,
        });
    }
    // Resolve linked-worktree paths up front (cheap), then scan them concurrently.
    let names = repo.worktrees().map_err(|e| format!("list worktrees: {e}"))?;
    let paths: Vec<PathBuf> = names
        .iter()
        .flatten()
        .filter_map(|name| repo.find_worktree(name).ok().map(|wt| wt.path().to_path_buf()))
        .collect();
    // Bounded fan-out: up to 16 worktrees scanned at once per batch.
    for chunk in paths.chunks(16) {
        let batch: Vec<WorktreeEntry> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk.iter().map(|p| s.spawn(|| linked_worktree_entry(p))).collect();
            handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
        });
        out.extend(batch);
    }
    Ok(out)
}

/// The shared `.git` directory for a repo and all its linked worktrees.
/// git2 0.19 has no `commondir()`, so derive it from `path()`:
/// main worktree → `<root>/.git`; linked worktree → `<root>/.git/worktrees/<name>`
/// (strip at the `worktrees` segment). Canonicalized so both forms match.
fn common_git_dir(repo: &git2::Repository) -> std::path::PathBuf {
    let p = repo.path();
    let base = match p.iter().position(|c| c == std::ffi::OsStr::new("worktrees")) {
        Some(pos) => p.iter().take(pos).collect::<std::path::PathBuf>(),
        None => p.to_path_buf(),
    };
    std::fs::canonicalize(&base).unwrap_or(base)
}

/// The main worktree directory = parent of the shared `.git` dir. Same for every
/// linked worktree of the repo, so it yields the canonical repo name.
fn main_worktree_dir(repo: &git2::Repository) -> Option<std::path::PathBuf> {
    common_git_dir(repo).parent().map(|p| p.to_path_buf())
}

/// Canonical repo display name — the main worktree's directory name (e.g. "delta"),
/// regardless of which (possibly linked) worktree path was opened.
pub fn repo_display_name(repo_path: &str) -> String {
    open_repo(repo_path)
        .ok()
        .and_then(|repo| main_worktree_dir(&repo))
        .map(|p| repo_name_from_path(&p.display().to_string()))
        .unwrap_or_else(|| repo_name_from_path(repo_path))
}

/// Registry repo entry: keyed by the git commondir so linked worktrees group together.
/// `root`/`name` describe the main worktree, not whichever worktree path was opened.
pub fn repo_entry(repo_path: &str) -> Result<RepoEntry, String> {
    let repo = open_repo(repo_path)?;
    let commondir = common_git_dir(&repo).display().to_string();
    let mut h = Sha256::new();
    h.update(commondir.as_bytes());
    let id: String = h.finalize()[..8].iter().map(|b| format!("{:02x}", b)).collect();
    let root = main_worktree_dir(&repo)
        .map(|p| p.display().to_string())
        .or_else(|| repo.workdir().map(|p| p.display().to_string()))
        .unwrap_or_else(|| repo_path.to_string());
    let name = repo_name_from_path(&root);
    let default_branch = resolve_base(&repo, None).ok().map(|(label, _)| label);
    let worktrees = list_worktrees(repo_path)?;
    Ok(RepoEntry { id, root, name, default_branch, worktrees })
}

/// Minimal percent-encoder for URL query values (RFC 3986 unreserved set preserved).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// The single choke point for "open this target". Focus-or-create, ≤1 per target.
pub fn open_target_window(app: &AppHandle, repo_path: &str, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    let repo = open_repo(repo_path)?;
    let canonical = repo
        .workdir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo_path.to_string());
    let worktree = resolve_worktree(&repo)?;
    let id = review_id(&canonical, &worktree);
    let label = format!("review-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let mut url = format!("index.html?repo={}&mode={}", enc(&canonical), mode.as_str());
    if let Some(b) = base.as_deref() {
        url.push_str(&format!("&base={}", enc(b)));
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Delta")
        .visible(false) // shown via show()+setFocus() after first paint so the window orders front
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // y is offset by ~10px from the window top in practice, so 26 lands the
            // 16px controls' top at ~16 → vertically centered in the 48px titlebar.
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 26.0));
    }
    builder.build().map_err(|e| format!("create window: {e}"))?;
    // Auto-refresh: watch this worktree and notify the window on change. (#9)
    crate::watch::start(app, &label, Path::new(&canonical));
    Ok(())
}

/// The cold-launch host window. The command palette (frontend) opens over it.
/// Focus-or-create the singleton `home` window.
pub fn open_home_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("home") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "home", WebviewUrl::App("index.html".into()))
        .title("Delta")
        .visible(false) // shown via show()+setFocus() after first paint so the window orders front
        .inner_size(1000.0, 680.0)
        .min_inner_size(800.0, 560.0)
        .center();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // y is offset by ~10px from the window top in practice, so 26 lands the
            // 16px controls' top at ~16 → vertically centered in the 48px titlebar.
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 26.0));
    }
    builder.build().map_err(|e| format!("create home window: {e}"))?;
    Ok(())
}

/// First-launch + single-instance routing: open the target's review window when
/// launched inside a repo, otherwise the home window (which shows the palette).
pub fn route_launch(app: &AppHandle, args: &[String], cwd: &Path) {
    let launch = parse_launch(args, cwd);
    let path = launch.repo_path.to_string_lossy().to_string();
    let opened = open_repo(&path).is_ok() && open_target_window(app, &path, launch.mode, None).is_ok();
    if !opened {
        let _ = open_home_window(app);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallOutcome {
    /// Symlinked into a directory already on PATH — runnable in open and new terminals.
    Linked { path: String },
    /// Symlinked into ~/.local/bin and wired that dir into the user's shell configs.
    /// New terminals pick it up automatically; an already-open shell won't until it
    /// re-reads its config. `shells` lists the shells we updated.
    LinkedPathUpdated { path: String, shells: Vec<String> },
    /// Couldn't install automatically; surface a command for the user to run.
    ManualNeeded { command: String, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub path: Option<String>,
}

/// Pure: pick the install dir. Prefer /usr/local/bin, else the first writable PATH dir.
pub fn choose_install_dir(path_dirs: &[PathBuf], is_writable: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    path_dirs
        .iter()
        .find(|p| p.ends_with("usr/local/bin") && is_writable(p.as_path()))
        .or_else(|| path_dirs.iter().find(|p| is_writable(p.as_path())))
        .cloned()
}

fn dir_is_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(".delta-write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn link_into(dir: &Path, exe: &Path) -> Result<InstallOutcome, String> {
    let link = dir.join("delta");
    if fs::symlink_metadata(&link).is_ok() {
        let _ = fs::remove_file(&link); // replace stale link/file
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(exe, &link).map_err(|e| format!("symlink: {e}"))?;
        Ok(InstallOutcome::Linked { path: link.display().to_string() })
    }
    #[cfg(not(unix))]
    {
        let _ = (exe, link);
        Err("CLI install is only supported on Unix".into())
    }
}

/// Dirs conventionally on a terminal's PATH that a GUI-launched macOS app's own
/// PATH usually omits (launchd hands a minimal PATH). Linking here lets `delta`
/// resolve in already-open and new terminals without touching any shell config.
fn preferred_bin_dirs() -> Vec<PathBuf> {
    vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/opt/homebrew/bin")]
}

pub fn install_cli() -> Result<InstallOutcome, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let path_var = std::env::var("PATH").unwrap_or_default();
    let path_dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();

    // 1) Prefer a writable dir that's conventionally on the terminal PATH (covers
    //    Homebrew Macs with zero config edits), then any writable PATH dir.
    let mut candidates = preferred_bin_dirs();
    candidates.extend(path_dirs.iter().cloned());
    if let Some(dir) = choose_install_dir(&candidates, dir_is_writable) {
        return link_into(&dir, &exe);
    }

    // 2) Fall back to ~/.local/bin (create it). If it isn't already on PATH, wire it
    //    into the user's shell configs so new terminals pick it up — no manual step.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let local_bin = home.join(".local/bin");
        if fs::create_dir_all(&local_bin).is_ok() && dir_is_writable(&local_bin) {
            link_into(&local_bin, &exe)?; // the symlink itself succeeded
            let path = local_bin.join("delta").display().to_string();
            if path_dirs.iter().any(|d| d == &local_bin) {
                return Ok(InstallOutcome::Linked { path });
            }
            let shells = ensure_dir_on_path(&home, &local_bin);
            return Ok(InstallOutcome::LinkedPathUpdated { path, shells });
        }
    }

    Ok(InstallOutcome::ManualNeeded {
        command: format!("sudo ln -sf '{}' /usr/local/bin/delta", exe.display()),
        reason: "No writable directory found on your PATH.".into(),
    })
}

/// Best-effort check for an installed `delta` shim in the dirs we (or a manual
/// install) would use, so the UI can stop offering to install it.
pub fn cli_status() -> CliStatus {
    let mut dirs = preferred_bin_dirs();
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    if let Ok(path_var) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    for dir in dirs {
        let link = dir.join("delta");
        if fs::symlink_metadata(&link).is_ok() {
            return CliStatus { installed: true, path: Some(link.display().to_string()) };
        }
    }
    CliStatus { installed: false, path: None }
}

/// Tags the block we append to a shell config so re-running install is idempotent.
const RC_MARKER: &str = "# Added by delta (delta CLI)";

/// POSIX (bash/zsh) snippet prepending `dir` to PATH.
fn posix_path_block(dir: &Path) -> String {
    format!("\n{RC_MARKER}\nexport PATH=\"{}:$PATH\"\n", dir.display())
}

/// fish snippet — fish manages PATH via its own builtin.
fn fish_path_block(dir: &Path) -> String {
    format!("\n{RC_MARKER}\nfish_add_path {}\n", dir.display())
}

/// Append `block` to `file` unless our marker is already there. Creates the file
/// (and parents) only when `create` is set — we don't want to materialize shell
/// configs the user doesn't use. Returns true if the file ends up wiring the dir.
fn append_block_if_missing(file: &Path, block: &str, create: bool) -> bool {
    match fs::read_to_string(file) {
        Ok(existing) => {
            if existing.contains(RC_MARKER) {
                return true; // already wired by a previous install
            }
            let mut contents = existing;
            contents.push_str(block);
            fs::write(file, contents).is_ok()
        }
        Err(_) if create => {
            if let Some(parent) = file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(file, block.trim_start_matches('\n')).is_ok()
        }
        Err(_) => false,
    }
}

/// Add `dir` to PATH across the user's shells by editing their rc files. zsh is the
/// macOS default so its config is created if absent; bash/fish are only touched when
/// the user already has them. Returns the shells we updated.
fn ensure_dir_on_path(home: &Path, dir: &Path) -> Vec<String> {
    let mut updated = Vec::new();
    if append_block_if_missing(&home.join(".zshrc"), &posix_path_block(dir), true) {
        updated.push("zsh".to_string());
    }
    let bash_updated = [".bashrc", ".bash_profile", ".profile"]
        .iter()
        .map(|f| home.join(f))
        .filter(|p| p.exists())
        .fold(false, |acc, p| append_block_if_missing(&p, &posix_path_block(dir), false) || acc);
    if bash_updated {
        updated.push("bash".to_string());
    }
    if home.join(".config/fish").is_dir() {
        if append_block_if_missing(&home.join(".config/fish/config.fish"), &fish_path_block(dir), true) {
            updated.push("fish".to_string());
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn enc_percent_encodes_path_separators_and_spaces() {
        assert_eq!(enc("/Users/me/my proj"), "%2FUsers%2Fme%2Fmy%20proj");
        assert_eq!(enc("feat/auth"), "feat%2Fauth");
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn list_worktrees_returns_main_only_for_simple_repo() {
        let (dir, _repo) = repo_with_commit();
        let wts = list_worktrees(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch, "main");
    }

    #[test]
    fn list_worktrees_includes_linked_worktrees() {
        let (dir, repo) = repo_with_commit();
        add_worktree(&repo, dir.path(), "delta-feat", "feat/auth");
        let mut wts = list_worktrees(dir.path().to_str().unwrap()).unwrap();
        wts.sort_by(|a, b| a.branch.cmp(&b.branch));
        let branches: Vec<&str> = wts.iter().map(|w| w.branch.as_str()).collect();
        assert!(branches.contains(&"main"));
        assert!(branches.contains(&"feat/auth"));
        assert_eq!(wts.iter().filter(|w| w.is_main).count(), 1);
    }

    #[test]
    fn repo_entry_has_name_default_branch_and_worktrees() {
        let (dir, _repo) = repo_with_commit();
        let entry = repo_entry(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entry.default_branch.as_deref(), Some("main"));
        assert!(!entry.id.is_empty());
        assert!(!entry.worktrees.is_empty());
    }

    #[test]
    fn parse_launch_no_args_targets_cwd() {
        // Bare `delta` resolves to the cwd, so launching inside a repo opens that
        // worktree; the home fallback is a downstream repo-validity check.
        let l = parse_launch(&[], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
        assert_eq!(l.mode, DiffMode::AllChanges);
    }

    #[test]
    fn parse_launch_dot_is_cwd() {
        let l = parse_launch(&[".".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
    }

    #[test]
    fn parse_launch_absolute_path_wins() {
        let l = parse_launch(&["/abs/repo".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
    }

    #[test]
    fn parse_launch_relative_path_joins_cwd() {
        let l = parse_launch(&["sub/dir".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj/sub/dir"));
    }

    #[test]
    fn parse_launch_mode_flags() {
        assert_eq!(parse_launch(&["--uncommitted".into()], Path::new("/c")).mode, DiffMode::Uncommitted);
        assert_eq!(parse_launch(&["--last-commit".into()], Path::new("/c")).mode, DiffMode::LastCommit);
        assert_eq!(parse_launch(&["--branch".into()], Path::new("/c")).mode, DiffMode::BranchVsBase);
    }

    #[test]
    fn parse_launch_flag_then_path() {
        let l = parse_launch(&["--uncommitted".into(), "/abs/repo".into()], Path::new("/c"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
        assert_eq!(l.mode, DiffMode::Uncommitted);
    }

    #[test]
    fn choose_prefers_usr_local_bin_when_writable() {
        let dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        assert_eq!(choose_install_dir(&dirs, |_| true), Some(PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn choose_falls_back_to_first_writable() {
        let dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        let chosen = choose_install_dir(&dirs, |p: &Path| p.ends_with("homebrew/bin"));
        assert_eq!(chosen, Some(PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn choose_none_when_nothing_writable() {
        let dirs = vec![PathBuf::from("/usr/local/bin")];
        assert_eq!(choose_install_dir(&dirs, |_| false), None);
    }

    #[test]
    fn path_blocks_carry_marker_and_dir() {
        let dir = Path::new("/Users/me/.local/bin");
        let posix = posix_path_block(dir);
        assert!(posix.contains(RC_MARKER));
        assert!(posix.contains("export PATH=\"/Users/me/.local/bin:$PATH\""));
        let fish = fish_path_block(dir);
        assert!(fish.contains(RC_MARKER));
        assert!(fish.contains("fish_add_path /Users/me/.local/bin"));
    }

    #[test]
    fn append_block_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let rc = tmp.path().join(".zshrc");
        let block = posix_path_block(Path::new("/x/bin"));
        // First run creates the file and writes the block once.
        assert!(append_block_if_missing(&rc, &block, true));
        // Second run is a no-op (marker already present) — no duplication.
        assert!(append_block_if_missing(&rc, &block, true));
        let contents = fs::read_to_string(&rc).unwrap();
        assert_eq!(contents.matches(RC_MARKER).count(), 1);
    }

    #[test]
    fn append_block_skips_creating_when_not_requested() {
        let tmp = tempfile::TempDir::new().unwrap();
        let rc = tmp.path().join(".bashrc");
        assert!(!append_block_if_missing(&rc, "x", false));
        assert!(!rc.exists());
    }

    #[test]
    fn ensure_dir_on_path_creates_zsh_and_touches_existing_only() {
        let home = tempfile::TempDir::new().unwrap();
        let home = home.path();
        // Pre-existing bash + fish configs; no zshrc yet.
        fs::write(home.join(".bashrc"), "# mine\n").unwrap();
        fs::create_dir_all(home.join(".config/fish")).unwrap();

        let updated = ensure_dir_on_path(home, &home.join(".local/bin"));
        assert!(updated.contains(&"zsh".to_string()));
        assert!(updated.contains(&"bash".to_string()));
        assert!(updated.contains(&"fish".to_string()));

        // zshrc was created; bash kept its original content + our block; fish wired.
        assert!(home.join(".zshrc").exists());
        assert!(fs::read_to_string(home.join(".bashrc")).unwrap().contains("# mine"));
        assert!(fs::read_to_string(home.join(".bashrc")).unwrap().contains(RC_MARKER));
        assert!(fs::read_to_string(home.join(".config/fish/config.fish")).unwrap().contains("fish_add_path"));
        // We never created a bash_profile the user didn't have.
        assert!(!home.join(".bash_profile").exists());
    }

    #[test]
    fn ensure_dir_on_path_without_fish_skips_fish() {
        let home = tempfile::TempDir::new().unwrap();
        let updated = ensure_dir_on_path(home.path(), &home.path().join(".local/bin"));
        assert_eq!(updated, vec!["zsh".to_string()]);
    }
}

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
    let repo_path = match path_token {
        None | Some(".") => cwd.to_path_buf(),
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => cwd.join(p),
    };
    Launch { repo_path, mode }
}

/// All checked-out worktrees of the repo: the main workdir + any linked worktrees.
pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let repo = open_repo(repo_path)?;
    let mut out = Vec::new();
    if let Some(wd) = repo.workdir() {
        out.push(WorktreeEntry {
            path: wd.display().to_string(),
            branch: resolve_worktree(&repo)?,
            is_main: true,
        });
    }
    let names = repo.worktrees().map_err(|e| format!("list worktrees: {e}"))?;
    for name in names.iter().flatten() {
        let wt = match repo.find_worktree(name) {
            Ok(wt) => wt,
            Err(_) => continue,
        };
        let wt_path = wt.path();
        if let Ok(wt_repo) = git2::Repository::open(wt_path) {
            let branch = resolve_worktree(&wt_repo).unwrap_or_else(|_| "(detached)".into());
            out.push(WorktreeEntry { path: wt_path.display().to_string(), branch, is_main: false });
        }
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
        .title("delta")
        .visible(false) // shown via show() after first paint; orders front + activates from a bg dev launch
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    }
    builder.build().map_err(|e| format!("create window: {e}"))?;
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
        .title("delta")
        .visible(false) // shown via show() after first paint; orders front + activates from a bg dev launch
        .inner_size(1000.0, 680.0)
        .min_inner_size(800.0, 560.0)
        .center();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
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
    Linked { path: String },
    ManualNeeded { command: String, reason: String },
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

pub fn install_cli() -> Result<InstallOutcome, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let path_var = std::env::var("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();

    if let Some(dir) = choose_install_dir(&dirs, dir_is_writable) {
        return link_into(&dir, &exe);
    }
    // Fall back to ~/.local/bin (create it); note if it isn't on PATH.
    if let Ok(home) = std::env::var("HOME") {
        let local_bin = PathBuf::from(home).join(".local/bin");
        if fs::create_dir_all(&local_bin).is_ok() && dir_is_writable(&local_bin) {
            link_into(&local_bin, &exe)?; // the symlink itself succeeded
            let path = local_bin.join("delta").display().to_string();
            let on_path = dirs.iter().any(|d| d == &local_bin);
            return Ok(InstallOutcome::Linked {
                path: if on_path { path } else { format!("{path}  (add ~/.local/bin to your PATH)") },
            });
        }
    }
    Ok(InstallOutcome::ManualNeeded {
        command: format!("sudo ln -sf '{}' /usr/local/bin/delta", exe.display()),
        reason: "No writable directory found on your PATH.".into(),
    })
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
    fn parse_launch_no_args_uses_cwd_all_changes() {
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
}

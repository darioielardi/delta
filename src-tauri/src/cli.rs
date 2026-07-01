//! The `delta` CLI shim: a no-Tauri client that forwards an open-target request
//! to the running app (or cold-launches the bundle via Launch Services) and exits.

use std::ffi::OsStr;
use std::io::{IsTerminal, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::git::model::DiffMode;
use crate::ipc::{cli_socket_path, CliRequest, IDENTIFIER};
use crate::launch::{launch_targets_non_repo, parse_launch};

/// Installed shim names. The app's own bundled executable is `Delta` / `Delta Dev`
/// (after `productName`), so a shim invocation always differs from the real name.
const SHIMS: [&str; 2] = ["delta", "delta-dev"];

const USAGE: &str = "\
delta — review git diffs with structured comments for AI agents

USAGE:
    delta [PATH] [MODE]

ARGS:
    PATH    Repository or worktree to open (default: current directory)

MODE (default: all changes):
    --all            All changes vs the base branch
    --uncommitted    Uncommitted working-tree changes
    --last-commit    The most recent commit
    --branch         This branch vs its base branch

OPTIONS:
    -h, --help       Print this help and exit
    -V, --version    Print version and exit

Runs inside a git repository. A running window for the same worktree is
focused; an explicit MODE switches it in place.
";

/// What a CLI invocation resolves to before any repo/socket work. Keeps the
/// argument-shape decision pure (and unit-testable) and out of `cli_main`'s I/O.
#[derive(Debug, PartialEq)]
pub enum PreCheck {
    Help,
    Version,
    /// An unrecognized `-x` / `--xyz` option (incl. a typo'd mode flag).
    BadFlag(String),
    Proceed,
}

/// Classify args: `--help`/`-h` and `--version`/`-V` win over everything (so a
/// typo alongside `--help` still shows help); otherwise the first unrecognized
/// flag is rejected; otherwise proceed to open.
pub fn precheck(args: &[String]) -> PreCheck {
    for a in args {
        match a.as_str() {
            "-h" | "--help" => return PreCheck::Help,
            "-V" | "--version" => return PreCheck::Version,
            _ => {}
        }
    }
    for a in args {
        if a.starts_with('-') && DiffMode::from_flag(a).is_none() {
            return PreCheck::BadFlag(a.clone());
        }
    }
    PreCheck::Proceed
}

/// Pure dispatch rule: we are the CLI client iff invoked under one of our shim names
/// AND we are not the app binary itself. "Not the app" holds when either the invoked
/// name differs from the real binary (shim `delta` vs bundle `Delta`), or we were
/// reached through the shim symlink (`via_symlink`).
///
/// The `via_symlink` backstop is casing-independent: it fires even when the bundle
/// binary shares the shim's basename — the `delta` shim → `.../MacOS/delta` collision
/// that shipped and hung the terminal (Tauri named the executable after the Cargo bin
/// `delta` because `mainBinaryName` was unset). Running the raw `target/release/delta`
/// binary directly (same name, and *not* reached via a symlink) stays in app mode.
pub fn is_cli_invocation(invoked: Option<&OsStr>, real: Option<&OsStr>, via_symlink: bool) -> bool {
    match invoked {
        Some(name) if SHIMS.iter().any(|s| name == OsStr::new(s)) => Some(name) != real || via_symlink,
        _ => false,
    }
}

pub fn invoked_as_cli() -> bool {
    // `invoked` is the name we were called by (the shim name, from argv[0]). `real`
    // is the actual binary: macOS `current_exe()` does NOT resolve the shim symlink,
    // so canonicalize it — otherwise both basenames are the shim name and the name
    // rule never fires.
    let argv0 = std::env::args_os().next();
    let invoked = argv0.as_deref().and_then(|p| Path::new(p).file_name()).map(OsStr::to_os_string);
    let exe = std::env::current_exe().ok();
    let real = exe
        .as_deref()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .and_then(|p| p.file_name().map(OsStr::to_os_string));
    // Backstop for the name rule: `current_exe()` being the (unresolved) shim symlink
    // means we were launched through the shim, not as the bundle binary. Checks the
    // leaf only (`symlink_metadata`), so a real binary living under a symlinked parent
    // dir — e.g. a dev `target/debug/delta` — is not mistaken for a shim launch.
    let via_symlink = exe
        .as_deref()
        .and_then(|p| std::fs::symlink_metadata(p).ok())
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    is_cli_invocation(invoked.as_deref(), real.as_deref(), via_symlink)
}

/// Pure: the argv passed to `open` for a cold launch. `open -b <id> --args <repo> [flag]`.
pub fn open_args(identifier: &str, repo: &str, mode: Option<DiffMode>) -> Vec<String> {
    let mut v = vec!["-b".into(), identifier.into(), "--args".into(), repo.into()];
    if let Some(m) = mode {
        v.push(m.flag().into());
    }
    v
}

/// CLI entry point. Returns a process exit code.
pub fn cli_main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Resolve help/version/unknown-flag before any repo or socket work, so
    // `delta --help` prints usage instead of silently opening the cwd's review.
    match precheck(&args) {
        PreCheck::Help => {
            print!("{USAGE}");
            return 0;
        }
        PreCheck::Version => {
            println!("delta {}", env!("DELTA_VERSION"));
            return 0;
        }
        PreCheck::BadFlag(flag) => {
            eprintln!("delta: unknown option '{flag}'");
            eprintln!("Try 'delta --help' for usage.");
            return 2;
        }
        PreCheck::Proceed => {}
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let launch = parse_launch(&args, &cwd);

    // Reject a non-repo target from a terminal (mirrors the old in-app guard).
    if launch_targets_non_repo(&launch) && std::io::stderr().is_terminal() {
        eprintln!("delta: not a git repository: {}", launch.repo_path.display());
        return 1;
    }

    let repo = launch.repo_path.to_string_lossy().to_string();
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => {
            eprintln!("delta: HOME is not set");
            return 1;
        }
    };
    let sock = cli_socket_path(IDENTIFIER, &home);

    match UnixStream::connect(&sock) {
        // App running: forward over the socket and exit immediately.
        Ok(mut stream) => {
            let req = CliRequest { repo, mode: launch.mode };
            match serde_json::to_string(&req) {
                Ok(line) => {
                    let _ = stream.write_all(line.as_bytes());
                    let _ = stream.write_all(b"\n");
                    0
                }
                Err(e) => {
                    eprintln!("delta: {e}");
                    1
                }
            }
        }
        // Not running (or stale socket): cold-launch the bundle via Launch Services.
        Err(_) => {
            let argv = open_args(IDENTIFIER, &repo, launch.mode);
            match Command::new("open").args(&argv).status() {
                Ok(s) if s.success() => 0,
                Ok(s) => {
                    eprintln!("delta: could not launch Delta ({s})");
                    1
                }
                Err(e) => {
                    eprintln!("delta: could not launch Delta: {e}");
                    1
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_mode_when_invoked_through_a_shim() {
        // Distinct names (bundle `Delta` via mainBinaryName) → the name rule alone fires.
        assert!(is_cli_invocation(Some(OsStr::new("delta")), Some(OsStr::new("Delta")), false));
        assert!(is_cli_invocation(Some(OsStr::new("delta-dev")), Some(OsStr::new("Delta Dev")), false));
    }

    #[test]
    fn cli_mode_when_shim_and_binary_share_a_name_but_reached_via_symlink() {
        // The regression that shipped and hung the terminal: the `delta` shim resolves
        // to a bundle binary *also* basenamed `delta` (Tauri used the Cargo bin name),
        // so the name rule can't tell them apart. The symlink backstop must still route
        // to CLI mode. The old (name-only) rule returned false here — an inline app run.
        assert!(is_cli_invocation(Some(OsStr::new("delta")), Some(OsStr::new("delta")), true));
        assert!(is_cli_invocation(Some(OsStr::new("delta-dev")), Some(OsStr::new("delta")), true));
    }

    #[test]
    fn app_mode_when_invoked_as_the_real_binary() {
        // Bundled app launched by LS/dock: argv0 basename == real exe name, not a symlink.
        assert!(!is_cli_invocation(Some(OsStr::new("Delta")), Some(OsStr::new("Delta")), false));
        // Raw cargo binary run directly during dev: same name AND not reached via symlink.
        assert!(!is_cli_invocation(Some(OsStr::new("delta")), Some(OsStr::new("delta")), false));
    }

    #[test]
    fn app_mode_when_name_is_not_a_shim() {
        assert!(!is_cli_invocation(Some(OsStr::new("something")), Some(OsStr::new("Delta")), false));
        // A non-shim name is never the CLI client, even reached through a symlink.
        assert!(!is_cli_invocation(Some(OsStr::new("something")), Some(OsStr::new("Delta")), true));
    }

    #[test]
    fn bundle_binary_name_differs_from_the_shim_names() {
        // Guard the fix at its source. The bundled executable is named after
        // `mainBinaryName`; if it's unset (or set to a shim name), Tauri falls back to
        // the Cargo bin name `delta`, which collides with the `delta` shim and drops
        // every terminal invocation into app mode — the window opens and the shell
        // hangs. Fails fast on that regression, unlike the basename tests above which
        // can't observe the real build output.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let name = conf.get("mainBinaryName").and_then(|v| v.as_str());
        assert!(
            matches!(name, Some(n) if !SHIMS.contains(&n)),
            "mainBinaryName must be set and differ from the shim names {SHIMS:?}; got {name:?}"
        );
    }

    #[test]
    fn open_args_appends_flag_only_when_mode_is_explicit() {
        assert_eq!(open_args("com.x", "/r", None), vec!["-b", "com.x", "--args", "/r"]);
        assert_eq!(
            open_args("com.x", "/r", Some(DiffMode::Uncommitted)),
            vec!["-b", "com.x", "--args", "/r", "--uncommitted"]
        );
    }

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn precheck_help_and_version_win() {
        assert_eq!(precheck(&v(&["--help"])), PreCheck::Help);
        assert_eq!(precheck(&v(&["-h"])), PreCheck::Help);
        assert_eq!(precheck(&v(&["--version"])), PreCheck::Version);
        assert_eq!(precheck(&v(&["-V"])), PreCheck::Version);
        // help is checked before the unknown-flag pass, so it wins.
        assert_eq!(precheck(&v(&["--bogus", "--help"])), PreCheck::Help);
    }

    #[test]
    fn precheck_rejects_unknown_flags() {
        assert_eq!(precheck(&v(&["--bogus"])), PreCheck::BadFlag("--bogus".into()));
        assert_eq!(precheck(&v(&["-x"])), PreCheck::BadFlag("-x".into()));
        // A typo'd mode flag is caught instead of silently opening the cwd.
        assert_eq!(precheck(&v(&["--uncomitted"])), PreCheck::BadFlag("--uncomitted".into()));
    }

    #[test]
    fn precheck_proceeds_for_paths_and_known_flags() {
        assert_eq!(precheck(&v(&[])), PreCheck::Proceed);
        assert_eq!(precheck(&v(&["/some/repo"])), PreCheck::Proceed);
        assert_eq!(precheck(&v(&["."])), PreCheck::Proceed);
        assert_eq!(precheck(&v(&["--uncommitted"])), PreCheck::Proceed);
        assert_eq!(precheck(&v(&["--branch", "/repo"])), PreCheck::Proceed);
    }
}

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

/// Pure dispatch rule: we are the CLI client iff invoked under a *different* name
/// than the real binary (i.e. through the installed shim symlink) and that name is
/// one of our shims. Running the raw `target/release/delta` binary (same name as
/// the real exe) stays in app mode — no footgun.
pub fn is_cli_invocation(invoked: Option<&OsStr>, real: Option<&OsStr>) -> bool {
    match invoked {
        Some(name) => Some(name) != real && SHIMS.iter().any(|s| name == OsStr::new(s)),
        None => false,
    }
}

pub fn invoked_as_cli() -> bool {
    // `invoked` is the name we were called by (the shim name, from argv[0]). `real`
    // is the actual binary: macOS `current_exe()` does NOT resolve the shim symlink,
    // so canonicalize it — otherwise both basenames are the shim name and the rule
    // below never fires.
    let argv0 = std::env::args_os().next();
    let invoked = argv0.as_deref().and_then(|p| Path::new(p).file_name()).map(OsStr::to_os_string);
    let real = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .and_then(|p| p.file_name().map(OsStr::to_os_string));
    is_cli_invocation(invoked.as_deref(), real.as_deref())
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
        assert!(is_cli_invocation(Some(OsStr::new("delta")), Some(OsStr::new("Delta"))));
        assert!(is_cli_invocation(Some(OsStr::new("delta-dev")), Some(OsStr::new("Delta Dev"))));
    }

    #[test]
    fn app_mode_when_invoked_as_the_real_binary() {
        // Bundled app launched by LS/dock: argv0 basename == real exe name.
        assert!(!is_cli_invocation(Some(OsStr::new("Delta")), Some(OsStr::new("Delta"))));
        // Raw cargo binary run directly during dev: both are "delta".
        assert!(!is_cli_invocation(Some(OsStr::new("delta")), Some(OsStr::new("delta"))));
    }

    #[test]
    fn app_mode_when_name_is_not_a_shim() {
        assert!(!is_cli_invocation(Some(OsStr::new("something")), Some(OsStr::new("Delta"))));
    }

    #[test]
    fn open_args_appends_flag_only_when_mode_is_explicit() {
        assert_eq!(open_args("com.x", "/r", None), vec!["-b", "com.x", "--args", "/r"]);
        assert_eq!(
            open_args("com.x", "/r", Some(DiffMode::Uncommitted)),
            vec!["-b", "com.x", "--args", "/r", "--uncommitted"]
        );
    }
}

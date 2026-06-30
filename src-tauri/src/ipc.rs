//! Cross-process IPC between the `delta` CLI shim and the running app.
//!
//! The app binds a unix-domain socket; a CLI invocation connects and forwards
//! one open-target request, then exits. Single-instance and detaching are
//! handled by macOS Launch Services (`open -b`), not a Tauri plugin.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Emitter, Manager};

use crate::git::model::DiffMode;

/// Bundle identifier this binary talks to. The debug build is a separate app so
/// `delta-dev` never forwards into an installed release. Mirrors `launch::CLI_NAME`.
#[cfg(not(debug_assertions))]
pub const IDENTIFIER: &str = "com.darioielardi.delta";
#[cfg(debug_assertions)]
pub const IDENTIFIER: &str = "com.darioielardi.delta.dev";

/// The rendezvous socket: stable, per-user, per-identifier. NOT `$TMPDIR` —
/// launchd hands the app a different `$TMPDIR` than the shell, so they'd never meet.
pub fn cli_socket_path(identifier: &str, home: &Path) -> PathBuf {
    home.join("Library/Application Support").join(identifier).join("cli.sock")
}

/// One open-target request forwarded from a CLI invocation. `mode` is `None`
/// when no mode flag was passed (focus only), `Some` for an explicit `--mode`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct CliRequest {
    pub repo: String,
    pub mode: Option<DiffMode>,
}

/// Bind the CLI socket and serve forwarded open-target requests. Best-effort:
/// any failure (e.g. an over-long socket path) logs and disables forwarding —
/// cold `open -b` still works, only warm forwarding degrades.
pub fn start(app: &AppHandle) {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return,
    };
    let sock = cli_socket_path(IDENTIFIER, &home);
    if let Some(parent) = sock.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&sock); // clear a stale socket from a prior crash
    // macOS caps sun_path at 104 bytes; bail cleanly rather than panic on bind.
    if sock.as_os_str().len() >= 104 {
        eprintln!("delta: cli socket path too long; CLI forwarding disabled");
        return;
    }
    let listener = match std::os::unix::net::UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("delta: bind cli socket: {e}");
            return;
        }
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut stream, &mut buf).is_err() {
                continue;
            }
            let Ok(req) = serde_json::from_str::<CliRequest>(buf.trim()) else { continue };
            let h = handle.clone();
            // Window create/focus must happen on the main thread.
            let _ = handle.run_on_main_thread(move || handle_request(&h, req));
        }
    });
}

/// Open (or focus) the target window. If we focused an already-open window AND the
/// request carried an explicit mode, forward it as `cli:set-mode` so the frontend
/// switches in place instead of ignoring it.
fn handle_request(app: &AppHandle, req: CliRequest) {
    let explicit = req.mode;
    let mode = req.mode.unwrap_or(DiffMode::AllChanges);
    if let Ok(crate::launch::Opened::Focused(label)) =
        crate::launch::open_target_window(app, &req.repo, mode, None)
    {
        if let Some(m) = explicit {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.emit("cli:set-mode", m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    #[test]
    fn socket_path_is_under_app_support_for_identifier() {
        let p = cli_socket_path("com.darioielardi.delta", Path::new("/Users/me"));
        assert_eq!(
            p,
            PathBuf::from("/Users/me/Library/Application Support/com.darioielardi.delta/cli.sock")
        );
    }

    #[test]
    fn request_round_trips_with_kebab_mode() {
        let r = CliRequest { repo: "/r".into(), mode: Some(DiffMode::Uncommitted) };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains(r#""mode":"uncommitted""#), "got {s}");
        assert_eq!(serde_json::from_str::<CliRequest>(&s).unwrap(), r);
    }

    #[test]
    fn request_round_trips_with_no_mode() {
        let r = CliRequest { repo: "/r".into(), mode: None };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<CliRequest>(&s).unwrap().mode, None);
    }

    #[test]
    fn unix_socket_carries_one_request() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("cli.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = String::new();
            s.read_to_string(&mut buf).unwrap();
            serde_json::from_str::<CliRequest>(buf.trim()).unwrap()
        });
        let mut c = UnixStream::connect(&sock).unwrap();
        let payload =
            serde_json::to_string(&CliRequest { repo: "/r".into(), mode: Some(DiffMode::BranchVsBase) }).unwrap();
        c.write_all(payload.as_bytes()).unwrap();
        c.flush().unwrap();
        drop(c); // EOF so the server's read_to_string returns
        let got = server.join().unwrap();
        assert_eq!(got, CliRequest { repo: "/r".into(), mode: Some(DiffMode::BranchVsBase) });
    }
}

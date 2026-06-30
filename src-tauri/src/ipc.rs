//! Cross-process IPC between the `delta` CLI shim and the running app.
//!
//! The app binds a unix-domain socket; a CLI invocation connects and forwards
//! one open-target request, then exits. Single-instance and detaching are
//! handled by macOS Launch Services (`open -b`), not a Tauri plugin.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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

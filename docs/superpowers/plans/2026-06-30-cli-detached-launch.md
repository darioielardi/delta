# Detached `delta` CLI launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `delta` terminal command return immediately and run the GUI detached under launchd, instead of the shell owning the app's event loop.

**Architecture:** One multicall binary. `main()` dispatches: invoked through the `delta`/`delta-dev` shim → run a no-Tauri CLI client that forwards the target to a running app over a unix-domain socket (or cold-launches the bundle via `open -b … --args …`) and exits; invoked as the app → run the app, which now listens on that socket. `tauri-plugin-single-instance` is removed (Launch Services + the socket subsume it). An explicit `--mode` on an already-open window is forwarded as a `cli:set-mode` event and applied in place.

**Tech Stack:** Rust, Tauri 2, `std::os::unix::net` (UnixListener/UnixStream), serde/serde_json, git2; React 19 + TypeScript frontend.

## Global Constraints

- **macOS-only.** New IPC/launch code uses unix sockets and `open`; no cross-platform abstraction.
- **Identifiers (verbatim):** release `com.darioielardi.delta`, dev `com.darioielardi.delta.dev`.
- **Shim names (verbatim):** release `delta`, dev `delta-dev` (the existing `CLI_NAME`).
- **Socket path:** `<HOME>/Library/Application Support/<identifier>/cli.sock`.
- **Event name (verbatim):** `cli:set-mode`.
- **`DiffMode` is `#[serde(rename_all = "kebab-case")]`** → `all-changes` / `uncommitted` / `last-commit` / `branch-vs-base`. CLI flags map `--all` / `--uncommitted` / `--last-commit` / `--branch`.
- **No Tauri command surface changes** in this plan, so the three-layer rule (`commands.rs`/`api.ts`/`mockBackend.ts`) does not apply. `cli:set-mode` is an event, not a command.
- **Conventional Commits.** Keep diffs scoped.
- **Gate before each commit:** `cargo test` (in `src-tauri/`) for Rust tasks; `npx tsc --noEmit` and `pnpm test` for frontend tasks.

---

### Task 1: `DiffMode::flag()`

**Files:**
- Modify: `src-tauri/src/git/model.rs` (impl block at lines 23-32; test module at line 34+)

**Interfaces:**
- Produces: `DiffMode::flag(&self) -> &'static str` returning the CLI flag (`--all` / `--uncommitted` / `--last-commit` / `--branch`). Used by the CLI client (Task 5) to build `open --args`.

- [ ] **Step 1: Write the failing test**

Add to the `model_tests` module in `src-tauri/src/git/model.rs`:

```rust
    #[test]
    fn diffmode_flag_is_the_cli_flag() {
        assert_eq!(DiffMode::AllChanges.flag(), "--all");
        assert_eq!(DiffMode::Uncommitted.flag(), "--uncommitted");
        assert_eq!(DiffMode::LastCommit.flag(), "--last-commit");
        assert_eq!(DiffMode::BranchVsBase.flag(), "--branch");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib git::model 2>&1 | tail -20`
Expected: FAIL — `no method named flag found for enum DiffMode`.

- [ ] **Step 3: Add the method**

In the `impl DiffMode` block in `src-tauri/src/git/model.rs`, below `as_str`:

```rust
    /// The CLI flag that selects this mode (inverse of `parse_launch`).
    pub fn flag(&self) -> &'static str {
        match self {
            DiffMode::AllChanges => "--all",
            DiffMode::Uncommitted => "--uncommitted",
            DiffMode::LastCommit => "--last-commit",
            DiffMode::BranchVsBase => "--branch",
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib git::model 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git/model.rs
git commit -m "feat(cli): add DiffMode::flag for CLI round-tripping"
```

---

### Task 2: `parse_launch` returns `Option<DiffMode>` and accepts `--all`

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (`Launch` struct lines 25-32; `parse_launch` lines 35-55; `route_launch` lines 274-281; tests lines 506-545)

**Interfaces:**
- Produces: `Launch.mode: Option<DiffMode>` — `None` when no mode flag was passed, `Some(x)` when one was. Consumed by the CLI client (Task 5) and socket handler (Task 6) to distinguish "explicit mode" from "default".

- [ ] **Step 1: Update the existing tests to the new `Option` shape (these are the failing tests)**

In `src-tauri/src/launch/mod.rs`, change these existing assertions:

```rust
    #[test]
    fn parse_launch_no_args_targets_cwd() {
        let l = parse_launch(&[], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
        assert_eq!(l.mode, None);
    }
```

```rust
    #[test]
    fn parse_launch_mode_flags() {
        assert_eq!(parse_launch(&["--all".into()], Path::new("/c")).mode, Some(DiffMode::AllChanges));
        assert_eq!(parse_launch(&["--uncommitted".into()], Path::new("/c")).mode, Some(DiffMode::Uncommitted));
        assert_eq!(parse_launch(&["--last-commit".into()], Path::new("/c")).mode, Some(DiffMode::LastCommit));
        assert_eq!(parse_launch(&["--branch".into()], Path::new("/c")).mode, Some(DiffMode::BranchVsBase));
    }
```

```rust
    #[test]
    fn parse_launch_flag_then_path() {
        let l = parse_launch(&["--uncommitted".into(), "/abs/repo".into()], Path::new("/c"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
        assert_eq!(l.mode, Some(DiffMode::Uncommitted));
    }
```

Add one new test:

```rust
    #[test]
    fn parse_launch_no_mode_flag_is_none_not_all_changes() {
        // `None` is what lets the socket handler tell "no --mode given" (focus only)
        // from an explicit `--all` (switch the open window to all-changes).
        assert_eq!(parse_launch(&["/abs/repo".into()], Path::new("/c")).mode, None);
        assert_eq!(parse_launch(&["--all".into()], Path::new("/c")).mode, Some(DiffMode::AllChanges));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib launch:: 2>&1 | tail -25`
Expected: FAIL to compile — `expected DiffMode, found Option<...>` (the struct field is still `DiffMode`).

- [ ] **Step 3: Change `Launch.mode` to `Option<DiffMode>`**

In `src-tauri/src/launch/mod.rs`, the struct (lines 25-32):

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The repo/worktree path to open. A bare invocation (no path arg) resolves to
    /// the cwd; whether that opens a review or falls back to Home is a downstream
    /// repo-validity check (see `route_launch`).
    pub repo_path: PathBuf,
    /// `None` when no mode flag was passed; `Some(_)` for an explicit `--all` /
    /// `--uncommitted` / `--last-commit` / `--branch`.
    pub mode: Option<DiffMode>,
}
```

- [ ] **Step 4: Update `parse_launch` to default to `None` and accept `--all`**

Replace the body of `parse_launch` (lines 35-55):

```rust
pub fn parse_launch(args: &[String], cwd: &Path) -> Launch {
    let mut mode: Option<DiffMode> = None;
    let mut path_token: Option<&str> = None;
    for arg in args {
        match arg.as_str() {
            "--all" => mode = Some(DiffMode::AllChanges),
            "--uncommitted" => mode = Some(DiffMode::Uncommitted),
            "--last-commit" => mode = Some(DiffMode::LastCommit),
            "--branch" => mode = Some(DiffMode::BranchVsBase),
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
```

- [ ] **Step 5: Update `route_launch` to default `None` → `AllChanges` at creation**

Replace `route_launch` (lines 274-281):

```rust
pub fn route_launch(app: &AppHandle, args: &[String], cwd: &Path) {
    let launch = parse_launch(args, cwd);
    let path = launch.repo_path.to_string_lossy().to_string();
    let mode = launch.mode.unwrap_or(DiffMode::AllChanges);
    let opened = open_repo(&path).is_ok() && open_target_window(app, &path, mode, None).is_ok();
    if !opened {
        let _ = open_home_window(app);
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib launch:: 2>&1 | tail -25`
Expected: PASS (all `parse_launch_*` tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/launch/mod.rs
git commit -m "feat(cli): make launch mode optional and add --all flag"
```

---

### Task 3: `open_target_window` reports focus-vs-create

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (`open_target_window` lines 189-227; add `Opened` enum)
- Modify: `src-tauri/src/commands.rs:310-311` (`open_target` command)

**Interfaces:**
- Produces: `pub enum Opened { Focused(String), Created(String) }` (the `String` is the `review-{id}` window label); `open_target_window(...) -> Result<Opened, String>`. The socket handler (Task 6) uses `Focused(label)` to decide whether to emit `cli:set-mode`.
- Consumes: existing callers `route_launch` (uses `.is_ok()`, unchanged) and `commands::open_target` (now maps to `()`).

> No new unit test: `open_target_window` needs a live Tauri app to create/focus a window, so it isn't headless-testable. This is a typed refactor — verified by the existing suite still passing and by the Task 10 manual matrix.

- [ ] **Step 1: Add the `Opened` enum**

In `src-tauri/src/launch/mod.rs`, just above `open_target_window` (line 189):

```rust
/// Outcome of `open_target_window`: whether an existing window was focused or a
/// new one created. The payload is the `review-{id}` window label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    Focused(String),
    Created(String),
}
```

- [ ] **Step 2: Change the signature and the two return points**

In `open_target_window`, change the return type and the early/late returns:

```rust
pub fn open_target_window(app: &AppHandle, repo_path: &str, mode: DiffMode, base: Option<String>) -> Result<Opened, String> {
```

The existing-window branch (lines 199-203) becomes:

```rust
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(Opened::Focused(label));
    }
```

The end of the function (replace the final `Ok(())` at line 226):

```rust
    crate::watch::start(app, &label, Path::new(&canonical));
    Ok(Opened::Created(label))
}
```

- [ ] **Step 3: Update the `open_target` command caller**

In `src-tauri/src/commands.rs:310-311`:

```rust
pub fn open_target(app: tauri::AppHandle, repo_path: String, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    open_target_window(&app, &repo_path, mode, base).map(|_| ())
}
```

(`route_launch` already uses `.is_ok()`, which still compiles — no change.)

- [ ] **Step 4: Build and run the full Rust suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: PASS (compiles; existing tests green).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/launch/mod.rs src-tauri/src/commands.rs
git commit -m "refactor(launch): report focus-vs-create from open_target_window"
```

---

### Task 4: `ipc` module — socket path, request type, protocol tests

**Files:**
- Create: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs:1-12` (add `mod ipc;`)

**Interfaces:**
- Produces: `ipc::IDENTIFIER: &str` (cfg-selected bundle id); `ipc::cli_socket_path(identifier: &str, home: &Path) -> PathBuf`; `ipc::CliRequest { repo: String, mode: Option<DiffMode> }` (serde). Consumed by the CLI client (Task 5) and the server (Task 6).

- [ ] **Step 1: Create `src-tauri/src/ipc.rs` with the pure pieces + tests**

```rust
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
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, add to the module list (after `mod git;`, keeping alpha-ish order is fine):

```rust
mod ipc;
```

- [ ] **Step 3: Run the ipc tests to verify they pass**

Run: `cd src-tauri && cargo test --lib ipc:: 2>&1 | tail -25`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): add cli socket path and request protocol"
```

---

### Task 5: `cli` module — name dispatch + client

**Files:**
- Create: `src-tauri/src/cli.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod cli;` and `pub use cli::{cli_main, invoked_as_cli};`)

**Interfaces:**
- Produces: `invoked_as_cli() -> bool` and `cli_main() -> i32` (called by `main`, Task 7). `is_cli_invocation` and `open_args` are pure helpers (tested here).
- Consumes: `ipc::{IDENTIFIER, cli_socket_path, CliRequest}` (Task 4); `launch::{parse_launch, launch_targets_non_repo}` (Task 2); `DiffMode::flag` (Task 1).

- [ ] **Step 1: Create `src-tauri/src/cli.rs` with pure helpers + their tests**

```rust
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
    let argv0 = std::env::args_os().next();
    let invoked = argv0.as_deref().and_then(|p| Path::new(p).file_name());
    let exe = std::env::current_exe().ok();
    let real = exe.as_deref().and_then(|p| p.file_name());
    is_cli_invocation(invoked, real)
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
```

- [ ] **Step 2: Register and re-export from `lib.rs`**

In `src-tauri/src/lib.rs`, add `mod cli;` to the module list, and after the `use tauri::Manager;` line add:

```rust
pub use cli::{cli_main, invoked_as_cli};
```

- [ ] **Step 3: Run the cli tests + full build**

Run: `cd src-tauri && cargo test --lib cli:: 2>&1 | tail -25`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cli.rs src-tauri/src/lib.rs
git commit -m "feat(cli): add name-dispatch client (socket forward or open -b)"
```

---

### Task 6: Socket server in the app

**Files:**
- Modify: `src-tauri/src/ipc.rs` (add `start` + `handle_request`)
- Modify: `src-tauri/src/lib.rs` (call `ipc::start` in `setup`)

**Interfaces:**
- Consumes: `launch::{open_target_window, Opened}` (Task 3); `ipc::{cli_socket_path, CliRequest, IDENTIFIER}` (Task 4).
- Produces: `ipc::start(app: &AppHandle)` — binds the socket and serves forwarded requests on the main thread, emitting `cli:set-mode` on an explicit-mode focus.

> Verified by build + the Task 10 manual matrix (binding a socket and creating windows needs a live app, not a headless test).

- [ ] **Step 1: Add `start` + `handle_request` to `src-tauri/src/ipc.rs`**

Add these imports at the top of `ipc.rs` (below the existing `use` lines):

```rust
use tauri::{AppHandle, Emitter, Manager};
```

Add, above the `#[cfg(test)]` module:

```rust
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
```

- [ ] **Step 2: Start the server in `setup`**

In `src-tauri/src/lib.rs`, inside the `.setup(|app| { … })` closure, after the `route_launch(...)` call and before the `#[cfg(debug_assertions)] devbridge` line:

```rust
            crate::ipc::start(app.handle());
```

- [ ] **Step 3: Build and run the full Rust suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: PASS (compiles; all existing + new tests green).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): serve forwarded CLI requests over the socket"
```

---

### Task 7: `main()` name dispatch

**Files:**
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `delta_lib::{invoked_as_cli, cli_main, run}` (Tasks 5, existing).

- [ ] **Step 1: Branch in `main`**

Replace `src-tauri/src/main.rs` body:

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Invoked through the `delta`/`delta-dev` shim → run the CLI client and exit,
    // without ever constructing the Tauri/webview runtime.
    if delta_lib::invoked_as_cli() {
        std::process::exit(delta_lib::cli_main());
    }
    delta_lib::run()
}
```

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(cli): dispatch to client mode when invoked as the shim"
```

---

### Task 8: Remove `tauri-plugin-single-instance` and the in-app TTY guard

**Files:**
- Modify: `src-tauri/Cargo.toml:33` (remove the dependency)
- Modify: `src-tauri/src/lib.rs` (remove the guard block lines 26-37 and the plugin registration lines 43-47)

**Interfaces:**
- None produced. Single-instance is now provided by Launch Services (a second `open -b` activates the running bundle) + the socket; the non-repo TTY guard now lives in `cli_main` (Task 5).

- [ ] **Step 1: Remove the dependency**

In `src-tauri/Cargo.toml`, delete the line:

```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 2: Remove the TTY guard block from `run()`**

In `src-tauri/src/lib.rs`, delete the leading `// CLI guard:` comment paragraph (the `// CLI guard: a terminal invocation …` block, currently lines 18-25) **and** the guard block it documents (currently lines 26-37). Its behavior now lives in `cli_main`. The block to delete:

```rust
    {
        use std::io::IsTerminal;
        if std::io::stderr().is_terminal() {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let launch = crate::launch::parse_launch(&args, &cwd);
            if crate::launch::launch_targets_non_repo(&launch) {
                eprintln!("delta: not a git repository: {}", launch.repo_path.display());
                std::process::exit(1);
            }
        }
    }
```

After this, `run()` opens with `let builder = tauri::Builder::default();`.

- [ ] **Step 3: Remove the single-instance plugin registration and its stale comment**

In `src-tauri/src/lib.rs`, delete the release-only plugin block **and** the now-misleading comment above it (the `// single-instance MUST be the first plugin registered…` paragraph, currently lines 38-42). The code block to delete (currently lines 43-47):

```rust
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let args: Vec<String> = argv.into_iter().skip(1).collect();
        crate::launch::route_launch(app, &args, std::path::Path::new(&cwd));
    }));
```

After this, the builder chain starts directly from `builder` at the `.plugin(tauri_plugin_window_state::Builder…)` call.

- [ ] **Step 4: Build and run the full suite**

Run: `cd src-tauri && cargo build 2>&1 | tail -15 && cargo test 2>&1 | tail -15`
Expected: builds clean (no reference to `tauri_plugin_single_instance`); tests pass.

- [ ] **Step 5: Update `Cargo.lock`**

Run: `cd src-tauri && cargo build 2>&1 | tail -5` (regenerates the lock without the plugin).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "refactor(launch): drop single-instance plugin in favor of LS + socket"
```

---

### Task 9: Frontend — apply `cli:set-mode` in place

**Files:**
- Modify: `src/workspace/Workspace.tsx` (add a listener effect near the `fs:changed` effect, lines 186-209)
- Modify: `src/workspace/Workspace.test.tsx` (extend the event mock; add a test)

**Interfaces:**
- Consumes: the `cli:set-mode` event emitted by `ipc::handle_request` (Task 6) with a `DiffMode` payload. Drives the existing in-place switch (`setDiffMode` → `openReview`).

- [ ] **Step 1: Extend the event mock and write the failing test**

In `src/workspace/Workspace.test.tsx`, replace the event mock (lines 26-33) so it also captures `cli:set-mode`:

```tsx
// Capture the event handlers the Workspace registers so tests can fire them.
let fsChanged: ((e: { payload: { paths: string[]; gitMeta: boolean } }) => void) | null = null;
let setMode: ((e: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: never }) => void) => {
    if (name === "fs:changed") fsChanged = cb as never;
    if (name === "cli:set-mode") setMode = cb as never;
    return Promise.resolve(() => {});
  },
}));
```

In the `beforeEach` (lines 49-54), reset it — add:

```tsx
    setMode = null;
```

Add this test after the "switching mode re-opens in place" test (after line 72):

```tsx
  it("applies an explicit --mode forwarded from the CLI in place (cli:set-mode)", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    openReview.mockClear();

    act(() => setMode?.({ payload: "uncommitted" }));
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- Workspace 2>&1 | tail -25`
Expected: FAIL — `setMode` is never assigned (no listener registered), so the `openReview` expectation times out.

- [ ] **Step 3: Add the listener effect in `Workspace.tsx`**

In `src/workspace/Workspace.tsx`, immediately after the `fs:changed` effect (after line 209), add:

```tsx
  // A CLI invocation that targets this already-open window with an explicit
  // --mode forwards it here, so we switch in place — focusing alone would ignore
  // the requested mode. Reuses the same path as the toolbar mode switcher.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const un = await listen<DiffMode>("cli:set-mode", (e) => setDiffMode(e.payload));
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm test -- Workspace 2>&1 | tail -25`
Expected: PASS (including the new test).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/Workspace.tsx src/workspace/Workspace.test.tsx
git commit -m "feat(workspace): switch diff mode in place on cli:set-mode"
```

---

### Task 10: Full-suite gate + real-app verification

**Files:** none (verification only).

> No new code. This task confirms the whole feature works end-to-end in the real app — the parts unit tests can't reach (LS launch, the socket, terminal return, window focus, in-place mode switch).

- [ ] **Step 1: Run every gate**

Run:
```bash
npx tsc --noEmit
pnpm test
( cd src-tauri && cargo test )
```
Expected: all green.

- [ ] **Step 2: Build the isolated dev app and install its shim**

Run: `pnpm dev:app` (this is `Delta Dev`, id `com.darioielardi.delta.dev`, CLI `delta-dev`). In the dev app's UI, use the CLI install affordance (or confirm `delta-dev` is symlinked onto PATH).

- [ ] **Step 3: Verify cold start returns immediately**

With no `Delta Dev` window open, from a terminal in a git repo:
```bash
time delta-dev .
```
Expected: the command returns in well under a second (does not block); a review window opens. Confirm the shell prompt is back while the window is up.

- [ ] **Step 4: Verify warm forward focuses without a new process**

With a window already open for that worktree, run `delta-dev .` again.
Expected: the existing window is focused; no second window; the command returns instantly. (Optionally confirm no transient extra process via Activity Monitor.)

- [ ] **Step 5: Verify explicit mode switches in place**

In a worktree whose window is open in "All changes", run:
```bash
delta-dev --uncommitted .
```
Expected: the open window switches to the Uncommitted view in place (scroll position / any draft preserved); no new window.
Then run `delta-dev .` (no flag) → window just focuses, mode unchanged.

- [ ] **Step 6: Verify non-repo rejection and launchd ownership**

```bash
cd /tmp && delta-dev .
```
Expected: prints `delta: not a git repository: /tmp` (or `/private/tmp`), exit code 1, no window.
Then: cold-launch a review with `delta-dev .` from a terminal, close that terminal window, and confirm the app keeps running (launchd-owned, not killed by the shell's exit).

- [ ] **Step 7: Verify single-instance still holds after plugin removal**

Quit the app. Run `delta-dev .` twice in quick succession from two shells.
Expected: a single app instance / single window for that target (Launch Services coalesces the launch).

- [ ] **Step 8: Final commit (if any verification fixes were needed)**

If steps 3-7 surfaced fixes, commit them with a scoped message; otherwise this task adds no commit.

---

## Notes for the implementer

- **Module order in `lib.rs`:** `mod cli;` and `mod ipc;` go alongside the existing `mod` declarations; `pub use cli::{cli_main, invoked_as_cli};` must be at crate root so `main.rs` can call `delta_lib::invoked_as_cli()`.
- **`emit` import:** `w.emit(...)` requires `tauri::Emitter` in scope (Tauri 2 split `Manager`/`Emitter`); it's imported in `ipc.rs` Task 6 Step 1.
- **Dev cold-start caveat:** `open -b com.darioielardi.delta.dev` only works if the dev bundle is registered with Launch Services (it is once `pnpm dev:app` has launched it at least once). A never-launched dev build can't be cold-started by the shim — not a release concern.
- **Boot-window race (deferred):** if the app is mid-launch when a warm `delta` runs, the socket may not be bound yet; the client falls back to `open`, which LS coalesces (args dropped). A short connect-retry would close this gap; out of scope for v1 (noted in the spec).

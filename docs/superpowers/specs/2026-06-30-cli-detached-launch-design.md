# Detached `delta` CLI launch — design

- **Date:** 2026-06-30
- **Status:** proposed
- **Scope:** make the `delta` terminal command return immediately and run the GUI
  detached under launchd, instead of the shell owning the app's event loop.
  macOS-only.

## Context

`delta` on PATH is a symlink to the app's **own** Mach-O binary — `install_cli`
symlinks `current_exe()` as `CLI_NAME` ([launch/mod.rs](../../../src-tauri/src/launch/mod.rs)).
There is one binary, no separate launcher. Running the shim execs the full Tauri
app in the shell's foreground; `tauri…run()` enters the OS event loop and never
returns until the app exits ([lib.rs](../../../src-tauri/src/lib.rs)). So:

- **Cold start** (no instance running): the `delta` process *is* the app → the
  terminal blocks until the app quits.
- **Warm start** (instance running): `tauri-plugin-single-instance` forwards argv
  to the primary and the secondary exits — the terminal returns, but only after
  booting a throwaway Tauri process just to forward.

Goal: `delta` returns instantly in both cases; the GUI is owned by launchd (so it
survives the terminal closing and activates correctly); warm forwarding doesn't
spin up a transient app process. Reference behavior: `code` / `zed` — a CLI that
talks to the running app and exits, with the GUI launched via the OS app-launch
path.

## Decisions (settled)

- **macOS-only.** Launch Services + a unix-domain socket. A clean seam is left for
  other OSes; they are not built.
- **Single multicall binary, name dispatch — NOT a separately-bundled CLI.**
  `main()` branches: invoked through the `delta`/`delta-dev` shim → run the CLI
  client and exit; invoked as the app (LS / dock / dev) → run the app. Rationale
  and the rejected alternative below.
- **Cold start launches the GUI via `open -b <identifier> --args …`** —
  launchd-owned, returns immediately.
- **Warm forwarding goes over a one-way unix-domain socket** the app listens on.
- **Remove `tauri-plugin-single-instance`** — LS single-instances the bundle and
  the socket subsumes argv forwarding.
- **`--wait` is not built.**
- **Explicit `--mode` is respected on an already-open window** via an in-place
  switch event; add `--all` so all four modes are explicitly requestable.

### Why multicall, not a separate bundled binary

The earlier discussion framed this as a separate thin `delta-cli` binary. This spec
switches to a single multicall binary: identical UX, materially less machinery, and
it removes the only real risk.

- **No Tauri bundling work.** Shipping a second executable inside `Delta.app` means
  an `externalBin` / build-copy dance (build `delta-cli`, stage it as
  `binaries/delta-cli-<triple>`, let Tauri embed it, resolve it at install time).
  Multicall ships nothing extra.
- **`install_cli` / `cli_status` / shell-rc wiring stay unchanged** — they already
  symlink `current_exe()` as the shim. Multicall only changes what that symlink
  *does* when invoked.
- **Negligible cost.** The client branch runs before any Tauri/webview init, so the
  only overhead vs a thin binary is dyld loading the (already-built) app binary —
  single-digit-to-low-tens of ms; still feels instant. The webview is never
  constructed.
- The rejected alternative (separate binary) buys cleaner separation and a smaller
  client image — neither user-visible. Not worth the bundling surface.

## Components

### 1. `main()` dispatch + `cli_main()` (client)

[main.rs](../../../src-tauri/src/main.rs):

```rust
fn main() {
    if delta_lib::invoked_as_cli() {
        std::process::exit(delta_lib::cli_main());
    }
    delta_lib::run();
}
```

**Dispatch rule — compare the invoked name to the real binary's name.** CLI mode iff
`argv[0]` basename differs from `current_exe()` basename (i.e. we were invoked through
the installed shim, under a different name than the real binary):

| Invocation | `argv[0]` basename | `current_exe()` basename | Mode |
|---|---|---|---|
| installed shim `delta` | `delta` | `Delta` | **CLI** |
| bundled app via LS / dock | `…/MacOS/Delta` | `Delta` | app |
| dev shim `delta-dev` | `delta-dev` | `Delta Dev` | **CLI** |
| raw dev binary `target/release/delta` | `delta` | `delta` | app |

The differ-rule is the key choice: it avoids the footgun where running the raw
cargo binary (`target/release/delta`, lowercase, same name as the shim) would wrongly
take the client path. Because the bundled executable is named after `productName`
(`Delta` / `Delta Dev`) while the shim is `delta` / `delta-dev`, the names differ
exactly when invoked through the shim. Belt-and-suspenders: also require the invoked
basename ∈ {`delta`, `delta-dev`}.

`cli_main() -> i32` (in `delta_lib`, no Tauri):

1. Parse argv with the existing `parse_launch` (now returns `Option<DiffMode>`).
2. **Non-repo guard** (moved here from `run()`): if `launch_targets_non_repo` and
   `stderr` is a TTY → `eprintln "delta: not a git repository: <path>"`, return 1.
3. Resolve the socket path for the target identifier (pure fn, §3).
4. `UnixStream::connect(sock)`:
   - **Ok** → write one JSON line `{ repo, mode }`, return 0.
   - **Err** → cold start: spawn `open -b <IDENTIFIER> --args <repo> [mode-flag]`,
     return 0. (The app reads these on boot.)

### 2. App-side socket server (`ipc` module)

In `setup()`, alongside the existing argv `route_launch` cold-start handling:

- Compute the socket path; unlink any stale file; `UnixListener::bind`.
- Spawn an accept thread (mirrors the background-thread pattern in
  [watch/](../../../src-tauri/src/watch)). Per connection: read one JSON request
  `{ repo, mode: Option<DiffMode> }`, then hand it to the main thread via
  `app.run_on_main_thread(…)` — window creation must be on the main thread.
- On the main thread: `open_target_window(repo, mode.unwrap_or(AllChanges), None)`,
  then apply the explicit-mode rule (§5).
- Best-effort `unlink` on exit. Per-connection errors are logged and isolated — one
  bad client never kills the listener.

The app keeps reading argv in `setup()` for the cold-start `--args` path; the socket
only carries *subsequent* (warm) requests.

### 3. Shared socket path (pure, in `delta_lib`)

```rust
pub fn cli_socket_path(identifier: &str, home: &Path) -> PathBuf
//  <home>/Library/Application Support/<identifier>/cli.sock
```

Both the client (release ⇒ `com.darioielardi.delta`, debug ⇒ `…delta.dev`, via the
same `cfg(debug_assertions)` split as `CLI_NAME`) and the app derive the path from
this one fn, so they can't disagree. Stable per-user, per-identifier — dev and
release isolate naturally.

It must **not** be `$TMPDIR`: launchd hands the app a different `$TMPDIR` than the
shell, so a CLI and the app would never rendezvous.

Constraint: macOS limits `sun_path` to 104 bytes. The chosen path
(`…/com.darioielardi.delta/cli.sock`, ~86 chars for a typical home) stays under it.
If a very long home would exceed the limit, the app logs and skips binding — cold
`open` still works, only warm forwarding degrades. Noted, not specially handled in v1.

### 4. `parse_launch` → `Option<DiffMode>` + `--all`

- `Launch.mode: Option<DiffMode>` — `None` when no mode flag is present, `Some(x)`
  for a flag.
- Add `--all` ⇒ `Some(DiffMode::AllChanges)` so all four modes are explicitly
  requestable (today all-changes is only the unflagged default, so "explicit
  all-changes" isn't expressible).
- Window **creation** defaults `None` → `AllChanges` (unchanged behavior).
- Existing `parse_launch` tests updated; add explicitness cases.

### 5. Explicit-mode respect on an already-open window

- `open_target_window` returns whether it focused an existing window vs created one
  (`enum Opened { Focused, Created }`). Existing callers (`commands::open_target`,
  cold-start `route_launch`) ignore the value — their behavior is unchanged.
- The socket handler: if `Opened::Focused` **and** the request's `mode` is `Some(m)`
  → `window.emit("cli:set-mode", m)` to that `review-{id}` window.
- Frontend ([Workspace.tsx](../../../src/workspace/Workspace.tsx)): add
  `listen<DiffMode>("cli:set-mode", e => setDiffMode(e.payload))`, reusing the
  existing in-place switch — a mode change re-runs `openReview` (diff recomputed,
  scroll and comment drafts preserved) and `syncModeParam` updates the URL. Mirrors
  the `fs:changed` listener already in that file.
- No flag (`None`) → focus only, mode untouched.

This touches no Tauri **command** surface, so the three-layer rule
(`commands.rs` / `api.ts` / `mockBackend.ts`) doesn't apply: `open_target`'s
signature change is internal Rust, and `cli:set-mode` is an event, not a command.
Mock mode (no CLI, no socket) simply never emits it.

## Data flow

- **Warm:** `delta path` → client connects → sends `{repo, mode}` → app handler →
  `open_target_window`. Existing window → focused (+ `cli:set-mode` if mode is
  explicit); none → created. Client exits instantly.
- **Cold:** connect fails → `open -b <id> --args path [mode]` → app boots,
  `setup()` opens the target from argv and starts the socket listener. Client exits
  instantly.
- **Non-repo from a TTY:** client prints `delta: not a git repository: <path>`,
  exit 1. No launch.

## What's removed / changed

- **Remove `tauri-plugin-single-instance`**: the dependency, the
  `#[cfg(not(debug_assertions))]` plugin registration, and its callback in
  `lib.rs`. Single-instance is now provided by LS (a second `open -b` activates the
  running bundle) plus the socket.
- **Remove the `IsTerminal` non-repo guard block from `run()`** — it moves to
  `cli_main`. The dock / Finder cold-launch → home-window behavior is unaffected
  (those don't go through the CLI).
- **`install_cli` / `cli_status` / shell-rc wiring: unchanged** — still symlink
  `current_exe()` as `CLI_NAME`. Multicall means the same symlink now dispatches to
  client mode.

## Edge cases

- **Stale socket** (app crashed, file remains): client `connect` → `ECONNREFUSED` →
  treated as not-running → `open`. The app unlinks a stale socket before binding.
- **Cold-start race** (two invocations, neither sees a socket): both `open -b` → LS
  coalesces to one app launch; the loser's `--args` may be dropped (its target won't
  open). Rare, acceptable, documented.
- **Boot window** (app launching, socket not yet bound): client `connect` fails →
  `open` → LS activates the launching instance, `--args` dropped. Brief. A short
  connect-retry (2–3 tries over ~150 ms) before falling back to `open` mitigates it.
  v1 may ship without the retry; noted.
- **`open -b` fails** (bundle not LS-registered — possible for an uninstalled dev
  build): the client surfaces the error. Dev (`delta-dev` → `…delta.dev`) relies on
  the `tauri dev` build being registered.
- **Different branch checked out** since a window opened: window identity is
  `review_id(workdir, branch)`, so a new branch yields a new window. Unchanged by
  this work; called out because it interacts with "focus the existing window".

## Tests / validation

**Rust units (pure):**
- `parse_launch` explicitness — flag ⇒ `Some`, none ⇒ `None`, `--all` ⇒
  `Some(AllChanges)`; plus the existing path/flag cases.
- `cli_socket_path` derivation (identifier + home → expected path).
- `invoked_as_cli` differ-rule (inject invoked/real basenames over the table above).
- The `open` arg builder ⇒ `["-b", id, "--args", repo, flag…]`.
- Request JSON (de)serialize round-trip.

**Rust integration:** bind a `UnixListener` in a tempdir, connect + send a request,
assert it parses to the expected `{repo, mode}` — the socket protocol, no Tauri.

**Frontend:** extend [Workspace.test.tsx](../../../src/workspace/Workspace.test.tsx)
(which already mocks `@tauri-apps/api/event` for `fs:changed` and tests the in-place
mode switch): fire `cli:set-mode` → assert it drives `setDiffMode` → `openReview`
with the new mode.

**Manual (real app, via the dev eval bridge):**
- Cold start returns to the shell immediately and the window opens.
- Warm `delta` focuses the existing window without a second process.
- `delta --uncommitted` on a window opened with `--branch` switches it in place.
- Non-repo from a TTY is rejected with the message; no window.
- Closing the launching terminal does **not** kill the app (launchd-owned).
- Two `delta` invocations still yield a single window (LS single-instance) after the
  plugin removal.

Gate before commit (per CLAUDE.md): `npx tsc --noEmit`, `pnpm test`, and
`cargo test` in `src-tauri/`.

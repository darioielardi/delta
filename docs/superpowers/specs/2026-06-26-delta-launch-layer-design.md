# delta — Plan 3: The Launch Layer — Design Spec

**Date:** 2026-06-26
**Status:** Approved for planning
**Topic:** The launch layer — a registry-backed launch picker, a true multi-window document model, and a thin `delta` CLI that opens or focuses per-target windows via single-instance (the same seam a future MCP server reuses).
**Builds on:** Plans 1 (diff viewer) & 2 (comment layer), on `main`. Read the root design spec `2026-06-25-delta-design.md` §6 (data model), §10.1 (picker), §12 (CLI), §15 (future compatibility) first — this spec refines and, where noted, deviates from it.

---

## 1. Summary

Plan 3 replaces the stopgap "Repo path" box in `Workspace.tsx` with the real launch experience and makes delta a genuine multi-document app:

1. **Registry** (`registry.json`) behind a storage trait — imported repos (with their worktrees) + denormalized review entries, so the picker renders fast. The registry is the picker's **index/cache only**; the source of truth stays one `<id>.json` per review, keyed by the deterministic `review_id` hash. The registry is rebuildable by scanning the reviews dir.
2. **Launch picker** — a Spotlight/⌘O-style window: recency-ordered review rows, fuzzy filter, and a keyboard-driven **＋ New review** drill (repo → worktree → mode).
3. **CLI (`delta`)** — a thin launcher. Resolves a target from `cwd` or a path and opens/focuses that target's window via Tauri single-instance. Plus an in-app **Install CLI** action.

The unifying idea: **every way of opening a review funnels through one Rust seam** — `open_target_window(repo_path, mode, base?)` — shared by the picker, the CLI, and a future MCP server.

## 2. Decisions settled during brainstorming

1. **True multi-window now** (not single-window routing). One backend process; a singleton picker window + one document window per review target (≤1 per target). The CLI is in-scope for Plan 3 and is *defined* in terms of per-target windows, so building it against a single-window model would be throwaway work.
2. **"Worktree" = a real checked-out git worktree** — the main working directory plus any `git worktree add` linked directories — enumerated **live**, not arbitrary branches. This is the only reading where all four diff modes stay valid (working-tree modes require a real checkout; delta is not a git client and will not check out branches, root spec §2). It collapses to a single auto-selected entry for the common single-checkout repo and genuinely pays off when parallel worktrees exist. Arbitrary branch-vs-branch comparison stays **future** (root spec §7 "custom comparisons").
3. **In-app "Install CLI" command** (VS Code `code` style), not a documented symlink — symlinks `delta` → the app's inner binary into a writable `PATH` dir, with a copyable fallback command when none is writable. No in-app `sudo`.

## 3. Deviations from the root design spec

- **§6 registry shape:** `repos[].worktrees` becomes objects `{ path, branch, isMain }` (not strings), and repos are keyed by **git commondir** so linked worktrees nest under one repo for the 3-step drill. Review entries gain `repoName` (denormalized for display).
- **§10.1 drill** is honored literally as **repo → worktree → mode**, with "worktree" reframed per Decision 2.2.
- Everything else (row contents, keys, recency, "no name / no save state") matches §10.1/§12.

---

## 4. Architecture: windows & the unifying seam

One backend process. Two window kinds, distinguished by Tauri window **label**:

| Label | Kind | Lifetime |
|---|---|---|
| `picker` | singleton launcher (Spotlight-style) | created lazily; hidden/shown via ⌘O — never destroyed |
| `review-<id>` | one document window per review target | created on open; closed by the user |

> Label uses a hyphen (`review-<id>`) — `id` is 16 hex chars, so the label is always `[a-z0-9-]`, safely within Tauri's allowed label charset. `≤1 window per target` falls out of label uniqueness.

### 4.1 The seam

```rust
// internal — the single choke point for "open this target"
fn open_target_window(app: &AppHandle, repo_path: &str, mode: DiffMode, base: Option<String>)
    -> Result<(), String> {
    let repo = open_repo(repo_path)?;                 // Plan 1
    let worktree = resolve_worktree(&repo)?;          // Plan 2 — live HEAD
    let id = review_id(repo_path, &worktree, mode);   // Plan 2 hash
    let label = format!("review-{id}");
    if let Some(w) = app.get_webview_window(&label) { w.set_focus().ok(); return Ok(()); }
    let url = format!("index.html?repo={}&mode={}{}",
        urlencode(repo_path), mode.as_str(),
        base.map(|b| format!("&base={}", urlencode(&b))).unwrap_or_default());
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("delta").inner_size(1440.0, 900.0).min_inner_size(900.0, 600.0)
        .title_bar_style(TitleBarStyle::Overlay).hidden_title(true)
        .traffic_light_position(LogicalPosition::new(19.0, 18.0))
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_target(app: AppHandle, repo_path: String, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    open_target_window(&app, &repo_path, mode, base)
}
```

Three callers, by design: the **picker** (`open_target` command), the **CLI** (single-instance callback, §7), and a **future MCP server** (same internal fn). Worktree is always resolved from the target path's live HEAD, so a window is keyed by the *actual current* target and `delta` run inside a linked-worktree dir just works.

### 4.2 In-webview routing

Windows all load the same Vite bundle. At boot, read `getCurrentWindow().label`:

- `picker` → render `<Picker>`.
- `review-*` → read `repo` / `mode` / `base` from `URLSearchParams` (reload-safe) and render the existing `<Workspace>` for that target.

`App.tsx` becomes this ~3-line router. `Workspace` loses the repo-path `<input>`/Open button and its `repoPath`/`opened` state; it receives the target as props and calls `api.openReview` on mount (the bootstrap path already exists). `main.tsx` keeps the `VITE_MOCK_IPC` hook; under mock, the label defaults to `picker` (configurable via a query param for verifying the workspace route).

### 4.3 Launch contexts (root spec §12)

- App icon / bare `delta` with no resolvable repo → show `picker`.
- `delta` / `delta .` / `delta <path>` inside a repo → `open_target_window` straight to the review (skip picker), default mode **All changes**.
- `⌘O` from any window → `show_picker` (show + focus the singleton).
- Opening a review from the picker **hides** the picker (stays alive for re-summon). `Esc` hides it.
- Closing the last window leaves the process running (macOS); dock-activate or `⌘O` re-summons the picker.

---

## 5. Registry model + storage

### 5.1 Model (Rust, `serde(rename_all = "camelCase")`)

```rust
struct Registry { version: u32, repos: Vec<RepoEntry>, reviews: Vec<ReviewEntry> }

struct RepoEntry {
    id: String,                  // hash of git commondir — groups linked worktrees
    root: String,                // main workdir (display anchor)
    name: String,                // basename of root
    default_branch: Option<String>,
    worktrees: Vec<WorktreeEntry>,   // cache; re-enumerated live during the drill
}
struct WorktreeEntry { path: String, branch: String, is_main: bool }

struct ReviewEntry {
    id: String,
    repo_name: String,           // denormalized for display
    target: Target,              // repoPath + worktree + mode + base
    last_opened_at: String,
    comment_count: u32,          // comments with scope != general (matches Workspace count)
    stale_count: u32,            // comments where stale == true
    viewed_count: u32,           // viewed.len()
    file_count: u32,             // diff file count; see §5.3
}
```

### 5.2 Storage trait

A second trait in the existing `storage` module, mirroring `JsonStorage`'s atomic-write pattern — single responsibility, separate from per-review `Storage`:

```rust
pub trait RegistryStore {
    fn load(&self) -> Result<Registry, String>;     // missing/corrupt → rebuild (§5.4)
    fn save(&self, reg: &Registry) -> Result<(), String>;  // temp file + rename
}
pub struct JsonRegistryStore { path: PathBuf }       // <app_data>/registry.json
```

### 5.3 Keeping the registry in sync

The registry is a **projection of review writes**. The commands that already persist a review also update its registry entry:

- `open_review` / `refresh_review` — have the freshly computed diff: upsert the review entry with **fresh `file_count`** (= `summary.files.len()`), refresh counts + `last_opened_at`, and `ensure_repo` (commondir, name, default branch, worktrees).
- `save_review` (frontend autosave; no diff recomputation) — upsert counts (`comment_count` / `stale_count` / `viewed_count`) but **preserve the existing `file_count`** (load prior entry; keep its value).
- `delete_review(id)` — remove `<id>.json` and the registry entry; if `review-<id>` is open, close it.

Sync failures are non-fatal to the review write (the review JSON is the source of truth); a failed registry update is logged, and the next open/save reconciles it.

### 5.4 Rebuild

If `registry.json` is missing or unparseable, `RegistryStore::load` rebuilds: scan the reviews dir, parse each `<id>.json`, derive `reviews[]` (counts from each `Review`; `file_count = 0`, unknown until the review is next opened), and rebuild `repos[]` by grouping review `repoPath`s via commondir + a live worktree enumeration. Rebuild is best-effort — a cache, not the truth.

---

## 6. Picker UI + new-review drill

`<Picker>` renders in the `picker` window. Spotlight layout: search field on top, recency-ordered rows below.

- **Row** (§10.1): `branch` + mode chip + `repo` · `💬 N` · derived `⚠ N stale` · last-opened (relative). No name, no save state. De-emphasize fully-viewed rows (only when `fileCount > 0 && viewedCount >= fileCount`, so a post-rebuild `fileCount = 0` row isn't mistaken for "done").
- **Fuzzy filter as you type:** hand-rolled subsequence matcher (no dependency), client-side over `reviews` (and repo names). Tiny scale (hundreds). Ranked by match quality then recency.
- **Keys:** `↑↓` navigate · `↵` open selected · `⌘N` new review · `⌘⌫` delete selected (with a confirm) · `Esc` hide.
- **Empty / first-run state:** prominent ＋ New review / Import, plus the Install CLI affordance.
- **Footer:** "Install `delta` CLI" action (§7.3).

### 6.1 The drill (＋ New review / `⌘N`)

Inline, keyboard-driven, three steps:

1. **Repo** — registry repos by name, plus **Import…** → `import_repo` opens a native folder dialog (Rust side), resolves the repo, registers it, and selects it.
2. **Worktree** — `list_worktrees(repoId)` enumerated **live**; when only the main worktree exists it auto-advances (still shown for one beat). Each entry shows branch + path; detached HEAD shows a short oid.
3. **Mode** — All changes (default) · Uncommitted · Last commit · Branch vs base.

Confirm → `open_target(worktreePath, mode, base = None)` → §4.1 seam → hide picker. The drill never picks a base (auto-detected via `resolve_base`); the per-review base override stays a Workspace concern (root spec §7/§10.1).

### 6.2 Commands consumed by the picker

`list_registry() -> Registry` · `import_repo() -> Option<RepoEntry>` (opens dialog, registers; `None` on cancel) · `list_worktrees(repo_id: String) -> Vec<WorktreeEntry>` · `open_target(...)` · `delete_review(id: String)` · `show_picker()` · `install_cli() -> InstallOutcome`.

All are mockable, so the entire picker + drill is `dev:mock` browser-verifiable; only the *window-spawning effect* of `open_target` needs a real build.

### 6.3 git2 worktree enumeration

```rust
fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let repo = open_repo(repo_path)?;
    let mut out = Vec::new();
    if let Some(wd) = repo.workdir() {                       // skip bare repos
        out.push(WorktreeEntry { path: wd.display().to_string(),
                                 branch: resolve_worktree(&repo)?, is_main: true });
    }
    for name in repo.worktrees()?.iter().flatten() {
        let wt = repo.find_worktree(name)?;
        let wt_repo = git2::Repository::open(wt.path())?;    // its own HEAD
        out.push(WorktreeEntry { path: wt.path().display().to_string(),
                                 branch: resolve_worktree(&wt_repo)?, is_main: false });
    }
    Ok(out)
}
```

`import_repo` derives `RepoEntry`: `id = hash(repo.commondir())`, `root = repo.workdir()`, `name = basename(root)`, `default_branch = resolve_base(&repo, None).0` (reuse Plan 1), `worktrees = list_worktrees(...)`.

---

## 7. CLI, single-instance, Install CLI

### 7.1 Argument parsing (pure, unit-tested)

```rust
struct Launch { repo_path: Option<PathBuf>, mode: DiffMode }
fn parse_launch(args: &[String], cwd: &Path) -> Launch
```

`args` excludes the binary name. Rules: `--uncommitted` / `--last-commit` / `--branch` set the mode (default **All changes**); the first non-flag token is a path (`.`, relative, or absolute — resolved against `cwd`, pure path arithmetic, no FS); no path token → `cwd`. The caller then `open_repo`-discovers (walk up for `.git`); if discovery fails → show picker.

### 7.2 Wiring

- **First launch** (no running instance): `setup` reads `std::env::args()` → `parse_launch` → discover → `open_target_window` or `show_picker`.
- **Subsequent `delta …`:** `tauri-plugin-single-instance` forwards `(argv, cwd)` to its callback → same `parse_launch` → discover → `open_target_window` (focus-or-create); the second process exits. **This is the MCP seam** (root spec §15).
- The static window in `tauri.conf.json` is **removed**; all windows are created programmatically (picker = compact/centered; review = 1440×900 + overlay titlebar). The single-instance plugin is registered.

### 7.3 Install CLI

```rust
enum InstallOutcome { Linked { path: String }, ManualNeeded { command: String, reason: String } }
fn install_cli() -> Result<InstallOutcome, String>
```

`current_exe()` → choose the first writable, existing `PATH` dir (prefer `/usr/local/bin`, else create/use `~/.local/bin` and note if it must be added to `PATH`) → symlink `delta` → exe (replace a stale link idempotently). If nothing is writable → `ManualNeeded { command: "ln -sf '<exe>' /usr/local/bin/delta", reason }` for the user to copy. The dir-selection is factored into a pure fn `choose_install_dir(path_dirs, is_writable) -> Option<PathBuf>` for unit testing with injected fakes. No `sudo` from inside the app.

> In `tauri dev`, `current_exe()` is the `target/debug` binary; Install CLI + single-instance are only meaningful and verifiable in a real `tauri build`.

---

## 8. Permissions & config

- Windows are created in **Rust** (`open_target`, `show_picker`), so **no JS window-API capability** is needed.
- The folder picker runs as a **Rust** `import_repo` command via `tauri-plugin-dialog`'s Rust API, so **no JS dialog capability** is needed.
- New crates: `tauri-plugin-single-instance`, `tauri-plugin-dialog`. `tauri.conf.json`: drop the static window; programmatic creation moves window options into the Rust builders.

## 9. Module layout (additive; mirrors Plan 2 boundaries)

- `src-tauri/src/registry/model.rs` — `Registry`, `RepoEntry`, `WorktreeEntry`, `ReviewEntry`, upsert/remove/rebuild helpers (pure where possible).
- `src-tauri/src/storage/mod.rs` — add `RegistryStore` + `JsonRegistryStore` alongside `JsonStorage`.
- `src-tauri/src/launch/mod.rs` — `parse_launch`, `open_target_window`, `show_picker`, single-instance callback, `install_cli` + `choose_install_dir`, worktree enumeration helpers.
- `src-tauri/src/commands.rs` — add `open_target`, `list_registry`, `import_repo`, `list_worktrees`, `delete_review`, `show_picker`, `install_cli`; thread registry sync into `open_review`/`save_review`/`refresh_review`.
- `src-tauri/src/lib.rs` — register plugins, commands, `setup` (first-launch routing), single-instance.
- Frontend: `src/App.tsx` (label router), `src/picker/Picker.tsx` + `NewReviewDrill.tsx` + `fuzzy.ts`, `src/picker/*.test.ts(x)`, `src/api.ts` (+ registry/launch methods), `src/types.ts` (+ registry types), `src/dev/mockBackend.ts` (+ registry/worktree fixtures), `src/workspace/Workspace.tsx` (de-stopgap, target via props).

## 10. Verification strategy

- **Rust `cargo test`:** `RegistryStore` load/save/rebuild + atomic write; `upsert_review`/`remove_review`/`ensure_repo`; commondir grouping; `list_worktrees` against a real git repo **with a linked worktree** (via `test_support`); `review_id` reuse; `parse_launch` argument matrix; `choose_install_dir` with injected PATH/writability.
- **Frontend `pnpm test` (vitest):** fuzzy matcher, row/count derivation, drill state machine, label→view router.
- **`pnpm dev:mock` (port 5599) + preview MCP / agent-browser:** picker render, filter-as-you-type, keyboard nav, full drill, empty/first-run — via extended `mockBackend` fixtures.
- **`pnpm tauri build` sign-off (build-only):** multi-window open/focus + ≤1-per-target, picker↔review windows, ⌘O summon/hide, CLI argv routing, single-instance focus, `install_cli` symlink. Acknowledged up front: window + CLI + install behavior is not `dev:mock`-testable.

## 11. Out of scope (Plan 3)

Arbitrary branch-vs-branch / custom comparisons; checking out branches; multi-worktree *creation*; Windows/Linux CLI install polish (the seam is cross-platform, the symlink UX is macOS-first); MCP server itself (only its seam is built); any change to the diff/comment surface (tracked separately in `docs/superpowers/backlog.md`).

## 12. Open questions / risks (non-blocking)

- **Tauri label charset** for `review-<id>` — hex + hyphen is safe; verified at build.
- **`file_count = 0` after a rebuild** until a review is reopened — acceptable for a cache; the row simply shows no file count briefly.
- **`/usr/local/bin` writability** varies by machine; the `ManualNeeded` fallback covers it. `~/.local/bin` may not be on `PATH`; surface that in the outcome message.
- **Picker singleton vs in-window ⌘O overlay** — we chose a dedicated Spotlight window (matches §10.1). If it feels heavy in use, an in-window overlay is a later refinement, not a re-architecture (the seam is unchanged).
- **Registry/review drift** if a `<id>.json` is deleted out-of-band — mitigated by rebuild-on-corrupt and best-effort sync; a stale row that fails to open can prune itself.

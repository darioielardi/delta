# delta — Plan 3: The Launch Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stopgap repo-path box with a real launch layer — a registry-backed Spotlight-style picker, a true multi-window document model (one window per review target), and a thin `delta` CLI that opens/focuses per-target windows via single-instance (the seam a future MCP server reuses).

**Architecture:** Every way of opening a review funnels through one Rust seam, `open_target_window(repo_path, mode, base?)` (resolve worktree from live HEAD → compute `review_id` → focus existing `review-<id>` window or create one). A `registry.json` behind a `RegistryStore` trait is the picker's denormalized index/cache (rebuildable from the reviews dir); the per-review `<id>.json` stays the source of truth. The picker + drill are a React view in a singleton `picker` window; review windows load the same bundle and route by window label. The CLI is the same app binary: `tauri-plugin-single-instance` forwards argv to the running instance, which routes through the same seam.

**Tech Stack:** Rust + git2 (Plan 1) + sha2/chrono/similar/serde_json (Plan 2) + `tauri-plugin-single-instance` + `tauri-plugin-dialog`; React 19 + TS; existing `@git-diff-view/react` 0.1.6 renderer boundary; vitest + happy-dom; the `VITE_MOCK_IPC` browser harness.

## Global Constraints

- **Builds on Plans 1 & 2 (on `main`).** Do not break `compute_diff`, `get_file_diff`, `open_review`, `refresh_review`, `save_review`, `export_review`, the `src/diff/` renderer boundary, or the reconcile/anchor/export logic.
- **Source of truth stays per-review.** `registry.json` is an index/cache only; reviews remain `<id>.json` keyed by `review_id(repoPath \0 worktree \0 mode)` (Plan 2). Registry is rebuildable from the reviews dir.
- **The seam is single.** Picker, CLI, and future MCP all open reviews via `open_target_window`. Worktree is always resolved from the target path's **live HEAD**.
- **Window labels:** `picker` (singleton) and `review-<id>` (`id` = 16 hex chars → label is `[a-z0-9-]`, safe charset). `≤1 window per target` follows from label uniqueness.
- **Windows + dialog created in Rust.** No JS window-API or JS dialog capability. Custom commands are not permission-gated; only widen `capabilities/default.json` `windows` to the new labels.
- **Rust↔TS payloads are camelCase** (`#[serde(rename_all = "camelCase")]`); `DiffMode` stays kebab-case; `CommentScope`/`Side` lowercase (Plan 2).
- **"Worktree" = a real checked-out git worktree** (main workdir + `git worktree add` linked dirs), enumerated live. Never arbitrary branches.
- **`comment_count` excludes `general`-scope** comments (matches `Workspace` count); `stale_count` = comments with `stale == true`; `viewed_count` = `viewed.len()`; `file_count` = diff file count (fresh on open/refresh, preserved on save, `0` after a rebuild).
- **Package manager is pnpm.** React 19 + React Compiler: **do not hand-write `useMemo`/`useCallback`/`React.memo`**.
- **Nothing is ever written into the user's repo / working tree.** Registry + reviews live in the app data dir.
- **Verification:** Rust = `export PATH="$HOME/.cargo/bin:$PATH" && cargo test` (run in `src-tauri/`). Frontend logic = `pnpm test`. Frontend behavior = `pnpm dev:mock` (port 5599) + preview MCP / agent-browser (extend `src/dev/mockBackend.ts` fixtures per task). **Window + CLI + install behavior is `pnpm tauri build`-only** — call it out, don't fake it.

---

### Task 1: Rust — deps + registry model

**Files:**
- Modify: `src-tauri/Cargo.toml` (add two plugins)
- Create: `src-tauri/src/registry/mod.rs`
- Create: `src-tauri/src/registry/model.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod registry;`)

**Interfaces:**
- Consumes: `crate::git::model::{Target, DiffMode}`, `crate::review::model::Review` (Plan 2).
- Produces:
  - `struct WorktreeEntry { path: String, branch: String, is_main: bool }` (camelCase).
  - `struct RepoEntry { id: String, root: String, name: String, default_branch: Option<String>, worktrees: Vec<WorktreeEntry> }` (camelCase).
  - `struct ReviewEntry { id, repo_name, target: Target, last_opened_at, comment_count: u32, stale_count: u32, viewed_count: u32, file_count: u32 }` (camelCase).
  - `struct Registry { version: u32, repos: Vec<RepoEntry>, reviews: Vec<ReviewEntry> }`; `Registry::empty()`.
  - `Registry::upsert_review(&mut self, ReviewEntry)` (replace by `id`, else push).
  - `Registry::remove_review(&mut self, id: &str)`.
  - `Registry::upsert_repo(&mut self, RepoEntry)` (replace by `id`, else push).
  - `ReviewEntry::from_review(review: &Review, file_count: u32, repo_name: String) -> ReviewEntry`.
  - `fn repo_name_from_path(repo_path: &str) -> String` (basename, fallback to the path).

- [ ] **Step 1: Add dependencies**

```toml
# src-tauri/Cargo.toml — append under [dependencies] (keep existing entries)
tauri-plugin-single-instance = "2"
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Create the module file**

```rust
// src-tauri/src/registry/mod.rs
pub mod model;
```

- [ ] **Step 3: Write the failing tests**

```rust
// src-tauri/src/registry/model.rs  (append a #[cfg(test)] mod at the bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot, ViewedEntry};

    fn review_with(comments: Vec<Comment>, viewed: Vec<ViewedEntry>) -> Review {
        let target = Target { repo_path: "/Users/me/proj".into(), worktree: Some("main".into()), mode: DiffMode::AllChanges, base: None };
        let mut r = Review::new("0123456789abcdef".into(), target, Snapshot { base_oid: "b".into(), head_oid: None, captured_at: "t".into() }, "t".into());
        r.comments = comments;
        r.viewed = viewed;
        r
    }
    fn comment(scope: CommentScope, stale: bool) -> Comment {
        Comment { id: "x".into(), scope, anchor: None, body: "b".into(), stale, created_at: "t".into(), updated_at: "t".into() }
    }

    #[test]
    fn from_review_counts_exclude_general_and_track_stale_viewed() {
        let r = review_with(
            vec![comment(CommentScope::Line, false), comment(CommentScope::File, true), comment(CommentScope::General, false)],
            vec![ViewedEntry { file: "a".into(), diff_hash: "h".into() }],
        );
        let e = ReviewEntry::from_review(&r, 7, "proj".into());
        assert_eq!(e.comment_count, 2, "general excluded");
        assert_eq!(e.stale_count, 1);
        assert_eq!(e.viewed_count, 1);
        assert_eq!(e.file_count, 7);
        assert_eq!(e.repo_name, "proj");
        assert_eq!(e.id, "0123456789abcdef");
    }

    #[test]
    fn upsert_review_replaces_by_id() {
        let mut reg = Registry::empty();
        let mut e = ReviewEntry::from_review(&review_with(vec![], vec![]), 1, "proj".into());
        reg.upsert_review(e.clone());
        e.file_count = 9;
        reg.upsert_review(e);
        assert_eq!(reg.reviews.len(), 1);
        assert_eq!(reg.reviews[0].file_count, 9);
    }

    #[test]
    fn remove_review_drops_entry() {
        let mut reg = Registry::empty();
        reg.upsert_review(ReviewEntry::from_review(&review_with(vec![], vec![]), 1, "proj".into()));
        reg.remove_review("0123456789abcdef");
        assert!(reg.reviews.is_empty());
    }

    #[test]
    fn repo_name_from_path_is_basename() {
        assert_eq!(repo_name_from_path("/Users/me/projects/delta"), "delta");
        assert_eq!(repo_name_from_path("/Users/me/projects/delta/"), "delta");
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml registry::`
Expected: FAIL (cannot find `Registry`, `ReviewEntry`, etc.).

- [ ] **Step 5: Implement the model**

```rust
// src-tauri/src/registry/model.rs  (above the tests module)
use crate::git::model::Target;
use crate::review::model::{CommentScope, Review};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub id: String,
    pub root: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub worktrees: Vec<WorktreeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    pub id: String,
    pub repo_name: String,
    pub target: Target,
    pub last_opened_at: String,
    pub comment_count: u32,
    pub stale_count: u32,
    pub viewed_count: u32,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub reviews: Vec<ReviewEntry>,
}

impl Registry {
    pub fn empty() -> Self {
        Registry { version: 1, repos: Vec::new(), reviews: Vec::new() }
    }

    pub fn upsert_review(&mut self, entry: ReviewEntry) {
        match self.reviews.iter_mut().find(|r| r.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.reviews.push(entry),
        }
    }

    pub fn remove_review(&mut self, id: &str) {
        self.reviews.retain(|r| r.id != id);
    }

    pub fn upsert_repo(&mut self, entry: RepoEntry) {
        match self.repos.iter_mut().find(|r| r.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.repos.push(entry),
        }
    }
}

impl ReviewEntry {
    pub fn from_review(review: &Review, file_count: u32, repo_name: String) -> Self {
        let comment_count = review.comments.iter().filter(|c| c.scope != CommentScope::General).count() as u32;
        let stale_count = review.comments.iter().filter(|c| c.stale).count() as u32;
        ReviewEntry {
            id: review.id.clone(),
            repo_name,
            target: review.target.clone(),
            last_opened_at: review.last_opened_at.clone(),
            comment_count,
            stale_count,
            viewed_count: review.viewed.len() as u32,
            file_count,
        }
    }
}

/// Basename of a repo/worktree path, falling back to the whole path.
pub fn repo_name_from_path(repo_path: &str) -> String {
    std::path::Path::new(repo_path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| repo_path.to_string())
}
```

- [ ] **Step 6: Wire the module**

```rust
// src-tauri/src/lib.rs — add alongside the other `mod` lines
mod registry;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml registry::`
Expected: PASS (4 tests). (Cargo will also fetch the two new plugin crates.)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/registry/ src-tauri/src/lib.rs
git commit -m "feat(registry): registry model + denormalized review entries"
```

---

### Task 2: Rust — RegistryStore trait + JsonRegistryStore + rebuild

**Files:**
- Modify: `src-tauri/src/storage/mod.rs` (add trait + impl + rebuild; keep `Storage`/`JsonStorage`)

**Interfaces:**
- Consumes: `crate::registry::model::{Registry, ReviewEntry, repo_name_from_path}`, `crate::review::model::Review`.
- Produces:
  - `pub trait RegistryStore { fn load(&self) -> Result<Registry, String>; fn save(&self, reg: &Registry) -> Result<(), String>; }`
  - `pub struct JsonRegistryStore { registry_path: PathBuf, reviews_dir: PathBuf }`; `JsonRegistryStore::new(registry_path, reviews_dir)`.
  - On `load`: parse `registry.json`; if missing or unparseable, **rebuild** by scanning `reviews_dir` for `*.json` (`file_count = 0`).

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/storage/mod.rs — extend the existing #[cfg(test)] mod tests (add these fns + imports)
    use crate::registry::model::{Registry, RepoEntry, ReviewEntry};

    #[test]
    fn registry_save_then_load_roundtrips() {
        let dir = TempDir::new().unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        let mut reg = Registry::empty();
        reg.upsert_repo(RepoEntry { id: "r1".into(), root: "/p".into(), name: "p".into(), default_branch: Some("main".into()), worktrees: vec![] });
        store.save(&reg).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.repos.len(), 1);
        assert_eq!(loaded.repos[0].name, "p");
    }

    #[test]
    fn registry_save_leaves_no_tmp_file() {
        let dir = TempDir::new().unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        store.save(&Registry::empty()).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert!(names.iter().any(|n| n == "registry.json"));
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "no tmp left, got {names:?}");
    }

    #[test]
    fn registry_load_missing_rebuilds_from_reviews_dir() {
        let dir = TempDir::new().unwrap();
        let reviews = dir.path().join("reviews");
        // seed one review doc via the per-review store
        let s = JsonStorage::new(reviews.clone());
        s.save(&sample()).unwrap(); // sample() has id 0123456789abcdef, worktree "main"
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), reviews);
        let reg = store.load().unwrap(); // registry.json does not exist → rebuild
        assert_eq!(reg.reviews.len(), 1);
        assert_eq!(reg.reviews[0].id, "0123456789abcdef");
        assert_eq!(reg.reviews[0].file_count, 0, "file_count unknown until reopened");
    }

    #[test]
    fn registry_load_corrupt_rebuilds() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("registry.json"), b"{ not json").unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        let reg = store.load().unwrap(); // corrupt → rebuild → empty (no reviews dir)
        assert!(reg.reviews.is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml storage::`
Expected: FAIL (cannot find `JsonRegistryStore`).

- [ ] **Step 3: Implement the trait + impl + rebuild**

```rust
// src-tauri/src/storage/mod.rs — add near the top imports
use crate::registry::model::{Registry, ReviewEntry, repo_name_from_path};

// ... below JsonStorage ...

pub trait RegistryStore {
    fn load(&self) -> Result<Registry, String>;
    fn save(&self, reg: &Registry) -> Result<(), String>;
}

pub struct JsonRegistryStore {
    registry_path: PathBuf,
    reviews_dir: PathBuf,
}

impl JsonRegistryStore {
    pub fn new(registry_path: PathBuf, reviews_dir: PathBuf) -> Self {
        JsonRegistryStore { registry_path, reviews_dir }
    }

    /// Best-effort rebuild from the reviews dir. file_count is unknown here (0).
    fn rebuild(&self) -> Registry {
        let mut reg = Registry::empty();
        let entries = match fs::read_dir(&self.reviews_dir) {
            Ok(e) => e,
            Err(_) => return reg, // no reviews yet
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(review) = serde_json::from_str::<Review>(&text) {
                    let name = repo_name_from_path(&review.target.repo_path);
                    reg.upsert_review(ReviewEntry::from_review(&review, 0, name));
                }
            }
        }
        reg
    }
}

impl RegistryStore for JsonRegistryStore {
    fn load(&self) -> Result<Registry, String> {
        match fs::read_to_string(&self.registry_path) {
            Ok(text) => match serde_json::from_str::<Registry>(&text) {
                Ok(reg) => Ok(reg),
                Err(_) => Ok(self.rebuild()), // corrupt → rebuild
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(self.rebuild()),
            Err(e) => Err(format!("read registry: {e}")),
        }
    }

    fn save(&self, reg: &Registry) -> Result<(), String> {
        if let Some(parent) = self.registry_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
        }
        let text = serde_json::to_string_pretty(reg).map_err(|e| format!("serialize registry: {e}"))?;
        let tmp = self.registry_path.with_extension("json.tmp");
        fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        fs::rename(&tmp, &self.registry_path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}
```

> Note: `Review` is already imported at the top of `storage/mod.rs` (Plan 2). If not, add `use crate::review::model::Review;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml storage::`
Expected: PASS (existing `Storage` tests + 4 new registry tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(registry): RegistryStore trait + atomic JSON store with rebuild"
```

---

### Task 3: Rust — worktree enumeration + repo metadata

**Files:**
- Create: `src-tauri/src/launch/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod launch;`)
- Modify: `src-tauri/src/git/mod.rs` (extend `test_support` with a linked-worktree helper)

**Interfaces:**
- Consumes: `crate::git::{open_repo, resolve_base, resolve_worktree}` (Plan 1/2), `crate::registry::model::{RepoEntry, WorktreeEntry, repo_name_from_path}`, `git2`, `sha2`.
- Produces:
  - `fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeEntry>, String>` — main workdir + linked worktrees, each with its own HEAD branch.
  - `fn repo_entry(repo_path: &str) -> Result<RepoEntry, String>` — `id = hex(sha256(commondir))`, `root`, `name`, `default_branch`, `worktrees`.

- [ ] **Step 1: Add a linked-worktree test helper**

```rust
// src-tauri/src/git/mod.rs — inside `pub(crate) mod test_support`, add:
    /// Add a linked worktree checked out on a new branch `branch`, at a sibling dir.
    /// Returns the worktree's path.
    pub fn add_worktree(repo: &Repository, root: &std::path::Path, name: &str, branch: &str) -> std::path::PathBuf {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(branch, &head, false).unwrap();
        let wt_path = root.parent().unwrap().join(name);
        let mut opts = git2::WorktreeAddOptions::new();
        let reference = repo.find_reference(&format!("refs/heads/{branch}")).unwrap();
        opts.reference(Some(&reference));
        repo.worktree(name, &wt_path, Some(&opts)).unwrap();
        wt_path
    }
```

- [ ] **Step 2: Write the failing tests**

```rust
// src-tauri/src/launch/mod.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

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
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::`
Expected: FAIL (module/functions undefined).

- [ ] **Step 4: Implement**

```rust
// src-tauri/src/launch/mod.rs — above the tests module
use crate::git::{open_repo, resolve_base, resolve_worktree};
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use sha2::{Digest, Sha256};

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

/// Registry repo entry: keyed by the git commondir so linked worktrees group together.
pub fn repo_entry(repo_path: &str) -> Result<RepoEntry, String> {
    let repo = open_repo(repo_path)?;
    let commondir = repo.commondir().display().to_string();
    let mut h = Sha256::new();
    h.update(commondir.as_bytes());
    let id: String = h.finalize()[..8].iter().map(|b| format!("{:02x}", b)).collect();
    let root = repo
        .workdir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo_path.to_string());
    let name = repo_name_from_path(&root);
    let default_branch = resolve_base(&repo, None).ok().map(|(label, _)| label);
    let worktrees = list_worktrees(repo_path)?;
    Ok(RepoEntry { id, root, name, default_branch, worktrees })
}
```

- [ ] **Step 5: Wire the module**

```rust
// src-tauri/src/lib.rs — add alongside the other `mod` lines
mod launch;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/launch/ src-tauri/src/git/mod.rs src-tauri/src/lib.rs
git commit -m "feat(launch): live git worktree enumeration + repo metadata"
```

---

### Task 4: Rust — registry sync into open/refresh/save + delete_review

**Files:**
- Modify: `src-tauri/src/commands.rs` (registry helpers + thread into open/refresh/save impls; add delete impl + command)

**Interfaces:**
- Consumes: `crate::storage::{JsonStorage, JsonRegistryStore, Storage, RegistryStore}`, `crate::registry::model::ReviewEntry`, `crate::launch::repo_entry`, `crate::review::reconcile::ReviewSession`.
- Produces:
  - `fn registry_path(app) -> Result<PathBuf, String>` (`<app_data>/registry.json`).
  - `fn sync_registry_after_open(reg_store, review, file_count)` — `repo_entry(repoPath)` → `upsert_repo`; `ReviewEntry::from_review(.., file_count, name)` → `upsert_review`; save (errors logged, non-fatal).
  - `fn sync_registry_after_save(reg_store, review)` — update counts, **preserve** existing `file_count` (or `0` if new); save (non-fatal).
  - `open_review_impl` / `refresh_review_impl` call `sync_registry_after_open` with `session.summary.files.len()`.
  - `save_review_impl` calls `sync_registry_after_save`.
  - `delete_review_impl(storage, reg_store, id) -> Result<(), String>` + `#[tauri::command] delete_review(app, id)`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/commands.rs — add to #[cfg(test)] mod tests
    use crate::storage::{JsonRegistryStore, RegistryStore};

    fn stores(dir: &std::path::Path) -> (JsonStorage, JsonRegistryStore) {
        let reviews = dir.join("reviews");
        (JsonStorage::new(reviews.clone()), JsonRegistryStore::new(dir.join("registry.json"), reviews))
    }

    #[test]
    fn open_review_populates_registry_with_file_count() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };

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
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();
        let original_file_count = session.summary.files.len() as u32;

        // simulate an autosave (e.g. add a comment) with no diff recomputation
        let mut review = session.review.clone();
        review.comments.push(Comment { id: "c1".into(), scope: crate::review::model::CommentScope::Line, anchor: None, body: "hi".into(), stale: false, created_at: "t".into(), updated_at: "t".into() });
        save_review_impl_with_registry(&storage, &reg_store, review).unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg.reviews.iter().find(|e| e.id == session.review.id).unwrap();
        assert_eq!(entry.file_count, original_file_count, "file_count preserved across save");
        assert_eq!(entry.comment_count, 1);
    }

    #[test]
    fn delete_review_removes_file_and_entry() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target { repo_path: repo_dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
        let session = open_review_impl_with_registry(&storage, &reg_store, target).unwrap();

        delete_review_impl(&storage, &reg_store, &session.review.id).unwrap();

        assert!(storage.load(&session.review.id).unwrap().is_none());
        assert!(reg_store.load().unwrap().reviews.iter().all(|e| e.id != session.review.id));
    }
```

> Note: rename the existing `open_review_impl` / `save_review_impl` / `refresh_review_impl` tests are kept; the new registry-aware impls are additive (see Step 3). Existing Plan 2 tests for the non-registry impls remain valid.

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml commands::`
Expected: FAIL (registry-aware impls + `delete_review_impl` undefined).

- [ ] **Step 3: Implement registry sync + delete, and thread into the commands**

```rust
// src-tauri/src/commands.rs — add imports
use crate::launch::repo_entry;
use crate::registry::model::{repo_name_from_path, ReviewEntry};
use crate::storage::{JsonRegistryStore, RegistryStore};

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("registry.json"))
}

fn reg_store(app: &tauri::AppHandle) -> Result<JsonRegistryStore, String> {
    Ok(JsonRegistryStore::new(registry_path(app)?, reviews_dir(app)?))
}

/// Upsert repo + review entry with a fresh file_count (open/refresh path). Non-fatal.
fn sync_registry_after_open(reg_store: &dyn RegistryStore, review: &Review, file_count: u32) {
    let result = (|| -> Result<(), String> {
        let mut reg = reg_store.load()?;
        if let Ok(entry) = repo_entry(&review.target.repo_path) {
            reg.upsert_repo(entry);
        }
        let name = repo_name_from_path(&review.target.repo_path);
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
        let prior_file_count = reg.reviews.iter().find(|e| e.id == review.id).map(|e| e.file_count).unwrap_or(0);
        let name = repo_name_from_path(&review.target.repo_path);
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
    let session = open_review_impl(storage, input)?;
    sync_registry_after_open(reg_store, &session.review, session.summary.files.len() as u32);
    Ok(session)
}

pub fn refresh_review_impl_with_registry(storage: &dyn Storage, reg_store: &dyn RegistryStore, review: Review) -> Result<ReviewSession, String> {
    let session = refresh_review_impl(storage, review)?;
    sync_registry_after_open(reg_store, &session.review, session.summary.files.len() as u32);
    Ok(session)
}

pub fn save_review_impl_with_registry(storage: &dyn Storage, reg_store: &dyn RegistryStore, review: Review) -> Result<(), String> {
    save_review_impl(storage, review.clone())?;
    sync_registry_after_save(reg_store, &review);
    Ok(())
}

pub fn delete_review_impl(storage: &dyn Storage, reg_store: &dyn RegistryStore, id: &str) -> Result<(), String> {
    storage.delete(id)?;
    let mut reg = reg_store.load()?;
    reg.remove_review(id);
    reg_store.save(&reg)
}
```

Then update the four command wrappers to use the registry-aware impls + add `delete_review`:

```rust
// src-tauri/src/commands.rs — replace the bodies of the existing command wrappers
#[tauri::command]
pub fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    open_review_impl_with_registry(&storage, &reg_store(&app)?, target)
}

#[tauri::command]
pub fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    refresh_review_impl_with_registry(&storage, &reg_store(&app)?, review)
}

#[tauri::command]
pub fn save_review(app: tauri::AppHandle, review: Review) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    save_review_impl_with_registry(&storage, &reg_store(&app)?, review)
}

#[tauri::command]
pub fn delete_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    delete_review_impl(&storage, &reg_store(&app)?, &id)
}
```

Add `delete` to the `Storage` trait + `JsonStorage`:

```rust
// src-tauri/src/storage/mod.rs — add to `pub trait Storage`
    fn delete(&self, id: &str) -> Result<(), String>;

// and to `impl Storage for JsonStorage`
    fn delete(&self, id: &str) -> Result<(), String> {
        if !is_valid_id(id) {
            return Err(format!("invalid review id: {id:?}"));
        }
        match fs::remove_file(self.path_for(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("delete review {id}: {e}")),
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (all prior + 3 new commands tests; storage gains a `delete`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/storage/mod.rs
git commit -m "feat(registry): sync registry on open/refresh/save + delete_review"
```

---

### Task 5: Rust — read-only registry commands (list_registry, list_worktrees, import_repo)

**Files:**
- Modify: `src-tauri/src/commands.rs` (three commands)

**Interfaces:**
- Consumes: `crate::launch::{list_worktrees as launch_list_worktrees, repo_entry}`, `reg_store(app)`, `tauri_plugin_dialog`.
- Produces:
  - `#[tauri::command] list_registry(app) -> Result<Registry, String>`.
  - `#[tauri::command] list_worktrees(repo_path: String) -> Result<Vec<WorktreeEntry>, String>`.
  - `#[tauri::command] import_repo(app) -> Result<Option<RepoEntry>, String>` — native folder dialog (Rust); on pick, `repo_entry` + `upsert_repo` + save; `None` on cancel.

- [ ] **Step 1: Implement the commands** (these are thin glue over Task 3/4 — verified via `dev:mock` + build, no new unit test beyond compile)

```rust
// src-tauri/src/commands.rs — add imports
use crate::launch::{list_worktrees as launch_list_worktrees, repo_entry};
use crate::registry::model::{Registry, RepoEntry, WorktreeEntry};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn list_registry(app: tauri::AppHandle) -> Result<Registry, String> {
    reg_store(&app)?.load()
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeEntry>, String> {
    launch_list_worktrees(&repo_path)
}

#[tauri::command]
pub fn import_repo(app: tauri::AppHandle) -> Result<Option<RepoEntry>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(path) = folder else { return Ok(None) };
    let repo_path = path.to_string();
    let entry = repo_entry(&repo_path)?;
    let store = reg_store(&app)?;
    let mut reg = store.load()?;
    reg.upsert_repo(entry.clone());
    store.save(&reg)?;
    Ok(Some(entry))
}
```

> `blocking_pick_folder()` returns the dialog plugin's `FilePath`; `.to_string()` yields the path. `import_repo` runs on a command thread (blocking dialog is fine there). If `repo_entry` fails (folder isn't a git repo), the `?` surfaces a readable error to the picker.

- [ ] **Step 2: Verify it compiles** (commands are registered in Task 8; this step is a compile gate)

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds (warnings for not-yet-registered commands are fine).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(registry): list_registry, list_worktrees, import_repo commands"
```

---

### Task 6: Rust — `parse_launch` (pure CLI argument parsing)

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (add `Launch` + `parse_launch`)

**Interfaces:**
- Consumes: `crate::git::model::DiffMode`.
- Produces:
  - `struct Launch { repo_path: PathBuf, mode: DiffMode }`.
  - `fn parse_launch(args: &[String], cwd: &Path) -> Launch` — pure (no filesystem). First non-flag token → path (resolved against `cwd`); none → `cwd`. Flags `--uncommitted` / `--last-commit` / `--branch` → mode; default `AllChanges`.

> Internal deviation from the design's `Option<PathBuf>`: a path is always determined (explicit or `cwd`); the *caller* decides picker-vs-window by attempting repo discovery. Simpler and equivalent.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/launch/mod.rs — add to the #[cfg(test)] mod tests
    use std::path::{Path, PathBuf};
    use crate::git::model::DiffMode;

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::parse_launch`
Expected: FAIL (`Launch` / `parse_launch` undefined).

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/launch/mod.rs — add near the top (after the existing `use` lines)
use crate::git::model::DiffMode;
use std::path::{Path, PathBuf};

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::parse_launch`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/launch/mod.rs
git commit -m "feat(cli): pure parse_launch for delta CLI arguments"
```

---

### Task 7: Rust — the window seam (`open_target_window`, `show_picker`) + commands

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (seam + builders + `enc` + `route_launch`)
- Modify: `src-tauri/src/commands.rs` (`open_target` / `show_picker` commands; `delete_review` also closes the window)

**Interfaces:**
- Consumes: `crate::git::{open_repo, resolve_worktree}`, `crate::git::model::DiffMode`, `crate::review::model::review_id`, `tauri::{AppHandle, Manager, WebviewWindowBuilder, WebviewUrl}`.
- Produces:
  - `fn enc(s: &str) -> String` — minimal percent-encoder for query values.
  - `fn open_target_window(app: &AppHandle, repo_path: &str, mode: DiffMode, base: Option<String>) -> Result<(), String>` — canonicalize to the repo workdir, compute `review-<id>`, focus-or-create.
  - `fn show_picker(app: &AppHandle) -> Result<(), String>`.
  - `fn route_launch(app: &AppHandle, args: &[String], cwd: &Path)` — `parse_launch` → discover → seam or picker.
  - Commands `open_target`, `show_picker` (in `commands.rs`).

- [ ] **Step 1: Write the failing test (the pure `enc` helper)**

```rust
// src-tauri/src/launch/mod.rs — add to #[cfg(test)] mod tests
    #[test]
    fn enc_percent_encodes_path_separators_and_spaces() {
        assert_eq!(enc("/Users/me/my proj"), "%2FUsers%2Fme%2Fmy%20proj");
        assert_eq!(enc("feat/auth"), "feat%2Fauth");
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e"); // unreserved preserved
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::enc_`
Expected: FAIL (`enc` undefined).

- [ ] **Step 3: Implement the seam**

```rust
// src-tauri/src/launch/mod.rs — add imports
use crate::review::model::review_id;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

fn review_window_builder<'a>(app: &'a AppHandle, label: &'a str, url: String) -> WebviewWindowBuilder<'a, tauri::Wry> {
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("delta")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    b
}

fn picker_window_builder(app: &AppHandle) -> WebviewWindowBuilder<'_, tauri::Wry> {
    let b = WebviewWindowBuilder::new(app, "picker", WebviewUrl::App("index.html".into()))
        .title("delta")
        .inner_size(760.0, 560.0)
        .min_inner_size(560.0, 420.0)
        .center();
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    b
}

/// The single choke point for "open this target". Focus-or-create, ≤1 per target.
pub fn open_target_window(app: &AppHandle, repo_path: &str, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    let repo = open_repo(repo_path)?;
    let canonical = repo
        .workdir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo_path.to_string());
    let worktree = resolve_worktree(&repo)?;
    let id = review_id(&canonical, &worktree, mode);
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
    review_window_builder(app, &label, url)
        .build()
        .map_err(|e| format!("create window: {e}"))?;
    Ok(())
}

pub fn show_picker(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    picker_window_builder(app)
        .build()
        .map_err(|e| format!("create picker: {e}"))?;
    Ok(())
}

pub fn hide_picker(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.hide();
    }
}

/// First-launch + single-instance routing.
pub fn route_launch(app: &AppHandle, args: &[String], cwd: &Path) {
    let launch = parse_launch(args, cwd);
    let path = launch.repo_path.to_string_lossy().to_string();
    let opened = open_repo(&path).is_ok() && open_target_window(app, &path, launch.mode, None).is_ok();
    if !opened {
        let _ = show_picker(app);
    }
}
```

- [ ] **Step 4: Run the `enc` test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::enc_`
Expected: PASS.

- [ ] **Step 5: Add the commands + window-close on delete**

```rust
// src-tauri/src/commands.rs — add imports
use crate::launch::{open_target_window, show_picker as launch_show_picker};
use crate::git::model::DiffMode;

#[tauri::command]
pub fn open_target(app: tauri::AppHandle, repo_path: String, mode: DiffMode, base: Option<String>) -> Result<(), String> {
    open_target_window(&app, &repo_path, mode, base)
}

#[tauri::command]
pub fn show_picker(app: tauri::AppHandle) -> Result<(), String> {
    launch_show_picker(&app)
}

#[tauri::command]
pub fn hide_picker(app: tauri::AppHandle) {
    crate::launch::hide_picker(&app);
}
```

Update the `delete_review` command (from Task 4) to also close an open window:

```rust
// src-tauri/src/commands.rs — replace the delete_review command body
#[tauri::command]
pub fn delete_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    delete_review_impl(&storage, &reg_store(&app)?, &id)?;
    if let Some(w) = app.get_webview_window(&format!("review-{id}")) {
        let _ = w.close();
    }
    Ok(())
}
```

> `app.get_webview_window` needs `use tauri::Manager;` — already imported in `commands.rs` (Plan 2).

- [ ] **Step 6: Compile gate** (window behavior is `tauri build`-only; just verify it builds)

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/launch/mod.rs src-tauri/src/commands.rs
git commit -m "feat(window): open_target_window seam + show_picker + route_launch"
```

---

### Task 8: Rust — single-instance, setup routing, command registration, config

**Files:**
- Modify: `src-tauri/src/lib.rs` (plugins, setup, full command registration)
- Modify: `src-tauri/tauri.conf.json` (remove the static window)
- Modify: `src-tauri/capabilities/default.json` (widen `windows` to new labels)

**Interfaces:**
- Consumes: `crate::launch::route_launch`, `tauri_plugin_single_instance`, `tauri_plugin_dialog`.
- Produces: a binary that, on first launch, routes argv → seam/picker; on a second invocation, focuses via single-instance.

- [ ] **Step 1: Rewrite `lib.rs`**

```rust
// src-tauri/src/lib.rs
mod anchor;
mod commands;
mod export;
mod git;
mod launch;
mod registry;
mod review;
mod storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            crate::launch::route_launch(app, &args, std::path::Path::new(&cwd));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review,
            commands::open_target,
            commands::show_picker,
            commands::hide_picker,
            commands::list_registry,
            commands::list_worktrees,
            commands::import_repo,
            commands::delete_review,
            commands::install_cli
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            crate::launch::route_launch(&app.handle(), &args, &cwd);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> `commands::install_cli` is registered now though it's implemented in Task 9. Either implement Task 9 before this build step, or temporarily drop that one line and re-add it in Task 9. The recommended order is to do Task 9 immediately after this step before the build gate.

- [ ] **Step 2: Remove the static window from `tauri.conf.json`**

```jsonc
// src-tauri/tauri.conf.json — replace "app".windows with an empty array
  "app": {
    "windows": [],
    "security": { "csp": null }
  },
```

(All window options now live in the Rust builders in `launch/mod.rs`.)

- [ ] **Step 3: Widen capabilities to the new window labels**

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for picker + review windows",
  "windows": ["main", "picker", "review-*"],
  "permissions": ["core:default", "opener:default"]
}
```

- [ ] **Step 4: Build gate** (do Task 9 first so `install_cli` exists)

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(cli): single-instance + setup routing + multi-window config"
```

---

### Task 9: Rust — Install CLI command

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (`InstallOutcome`, `choose_install_dir`, `install_cli`)
- Modify: `src-tauri/src/commands.rs` (`install_cli` command)

**Interfaces:**
- Produces:
  - `enum InstallOutcome { Linked { path }, ManualNeeded { command, reason } }` (serde tag `kind`, camelCase).
  - `fn choose_install_dir(path_dirs: &[PathBuf], is_writable: impl Fn(&Path) -> bool) -> Option<PathBuf>` (pure; prefer `/usr/local/bin`, else first writable).
  - `fn install_cli() -> Result<InstallOutcome, String>`.
  - `#[tauri::command] install_cli() -> Result<InstallOutcome, String>`.

- [ ] **Step 1: Write the failing tests (pure dir selection)**

```rust
// src-tauri/src/launch/mod.rs — add to #[cfg(test)] mod tests
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::choose_`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/launch/mod.rs — add imports + code
use serde::Serialize;
use std::fs;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallOutcome {
    Linked { path: String },
    ManualNeeded { command: String, reason: String },
}

/// Pure: pick the install dir. Prefer /usr/local/bin, else the first writable PATH dir.
pub fn choose_install_dir(path_dirs: &[PathBuf], is_writable: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if let Some(p) = path_dirs.iter().find(|p| p.ends_with("usr/local/bin") && is_writable(p)) {
        return Some(p.clone());
    }
    path_dirs.iter().find(|p| is_writable(p)).cloned()
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
    std::os::unix::fs::symlink(exe, &link).map_err(|e| format!("symlink: {e}"))?;
    Ok(InstallOutcome::Linked { path: link.display().to_string() })
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
            let outcome = link_into(&local_bin, &exe)?;
            if !dirs.iter().any(|d| d == &local_bin) {
                return Ok(InstallOutcome::ManualNeeded {
                    command: format!("export PATH=\"$HOME/.local/bin:$PATH\"  # add to your shell profile"),
                    reason: format!("Linked delta into {} — add that directory to your PATH.", local_bin.display()),
                });
            }
            return Ok(outcome);
        }
    }
    Ok(InstallOutcome::ManualNeeded {
        command: format!("sudo ln -sf '{}' /usr/local/bin/delta", exe.display()),
        reason: "No writable directory found on your PATH.".into(),
    })
}
```

- [ ] **Step 4: Add the command**

```rust
// src-tauri/src/commands.rs — add
use crate::launch::{install_cli as launch_install_cli, InstallOutcome};

#[tauri::command]
pub fn install_cli() -> Result<InstallOutcome, String> {
    launch_install_cli()
}
```

- [ ] **Step 5: Run tests + build**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml launch::tests::choose_ && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: PASS + builds (now `lib.rs` from Task 8 compiles with `install_cli` registered).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/launch/mod.rs src-tauri/src/commands.rs
git commit -m "feat(cli): install_cli command with writable-dir selection + manual fallback"
```

---

### Task 10: Frontend — types, api client, route resolver

**Files:**
- Modify: `src/types.ts` (registry + install types)
- Modify: `src/api.ts` (new command methods)
- Create: `src/route.ts`
- Create: `src/route.test.ts`

**Interfaces:**
- Produces:
  - Types: `WorktreeEntry`, `RepoEntry`, `ReviewEntry`, `Registry`, `InstallOutcome`.
  - `api.listRegistry`, `api.listWorktrees`, `api.importRepo`, `api.openTarget`, `api.deleteReview`, `api.showPicker`, `api.installCli`.
  - `type Route = { kind: "picker" } | { kind: "review"; target: Target }`; `resolveRoute(label, search) -> Route`.

- [ ] **Step 1: Add types**

```ts
// src/types.ts — append
export interface WorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface RepoEntry {
  id: string;
  root: string;
  name: string;
  defaultBranch?: string | null;
  worktrees: WorktreeEntry[];
}

export interface ReviewEntry {
  id: string;
  repoName: string;
  target: Target;
  lastOpenedAt: string;
  commentCount: number;
  staleCount: number;
  viewedCount: number;
  fileCount: number;
}

export interface Registry {
  version: number;
  repos: RepoEntry[];
  reviews: ReviewEntry[];
}

export type InstallOutcome =
  | { kind: "linked"; path: string }
  | { kind: "manualNeeded"; command: string; reason: string };
```

- [ ] **Step 2: Add api methods**

```ts
// src/api.ts — add to the `api` object, and extend the import line:
//   import type { Target, DiffSummary, FileDiff, Review, ReviewSession,
//                 Registry, WorktreeEntry, RepoEntry, InstallOutcome, DiffMode } from "./types";
  listRegistry: (): Promise<Registry> => invokeImpl("list_registry"),
  listWorktrees: (repoPath: string): Promise<WorktreeEntry[]> =>
    invokeImpl("list_worktrees", { repoPath }),
  importRepo: (): Promise<RepoEntry | null> => invokeImpl("import_repo"),
  openTarget: (repoPath: string, mode: DiffMode, base?: string): Promise<void> =>
    invokeImpl("open_target", { repoPath, mode, base }),
  deleteReview: (id: string): Promise<void> => invokeImpl("delete_review", { id }),
  showPicker: (): Promise<void> => invokeImpl("show_picker"),
  hidePicker: (): Promise<void> => invokeImpl("hide_picker"),
  installCli: (): Promise<InstallOutcome> => invokeImpl("install_cli"),
```

- [ ] **Step 3: Write the failing route tests**

```ts
// src/route.test.ts
import { describe, it, expect } from "vitest";
import { resolveRoute } from "./route";

describe("resolveRoute", () => {
  it("routes the picker label to the picker", () => {
    expect(resolveRoute("picker", "")).toEqual({ kind: "picker" });
  });

  it("routes a review label + params to a review target", () => {
    const r = resolveRoute("review-0123456789abcdef", "?repo=%2Fr%2Fp&mode=uncommitted&base=main");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r/p", mode: "uncommitted", base: "main" } });
  });

  it("supports a mock ?view=review override with no Tauri label", () => {
    const r = resolveRoute(null, "?view=review&repo=%2Fr&mode=all-changes");
    expect(r).toEqual({ kind: "review", target: { repoPath: "/r", mode: "all-changes", base: undefined } });
  });

  it("falls back to all-changes for an unknown mode", () => {
    const r = resolveRoute("review-x", "?repo=%2Fr&mode=bogus");
    expect(r.kind).toBe("review");
    if (r.kind === "review") expect(r.target.mode).toBe("all-changes");
  });

  it("defaults to picker with no label and no params", () => {
    expect(resolveRoute(null, "")).toEqual({ kind: "picker" });
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm test route`
Expected: FAIL (`./route` not found).

- [ ] **Step 5: Implement**

```ts
// src/route.ts
import type { DiffMode, Target } from "./types";

export type Route = { kind: "picker" } | { kind: "review"; target: Target };

const MODES: DiffMode[] = ["all-changes", "uncommitted", "last-commit", "branch-vs-base"];

export function resolveRoute(label: string | null, search: string): Route {
  const params = new URLSearchParams(search);
  const isReview = (label?.startsWith("review-") ?? false) || params.get("view") === "review";
  if (!isReview) return { kind: "picker" };

  const repoPath = params.get("repo") ?? "";
  const modeParam = params.get("mode");
  const mode = (MODES.includes(modeParam as DiffMode) ? modeParam : "all-changes") as DiffMode;
  const base = params.get("base") ?? undefined;
  return { kind: "review", target: { repoPath, mode, base } };
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm test route`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/api.ts src/route.ts src/route.test.ts
git commit -m "feat(launch): frontend registry types, api methods, window-label router"
```

---

### Task 11: Frontend — fuzzy matcher + review ranking

**Files:**
- Create: `src/picker/fuzzy.ts`
- Create: `src/picker/fuzzy.test.ts`

**Interfaces:**
- Consumes: `ReviewEntry` (`src/types`).
- Produces:
  - `fuzzyMatch(query: string, text: string): number | null` — subsequence match, higher score = better, `null` = no match, `""` query → `0`.
  - `rankReviews(reviews: ReviewEntry[], query: string): ReviewEntry[]` — filter by fuzzy over `branch + mode + repoName`, sort by score desc then `lastOpenedAt` desc.

- [ ] **Step 1: Write the failing tests**

```ts
// src/picker/fuzzy.test.ts
import { describe, it, expect } from "vitest";
import { fuzzyMatch, rankReviews } from "./fuzzy";
import type { ReviewEntry } from "../types";

function entry(id: string, branch: string, repoName: string, lastOpenedAt: string): ReviewEntry {
  return { id, repoName, target: { repoPath: `/r/${repoName}`, worktree: branch, mode: "all-changes" },
    lastOpenedAt, commentCount: 0, staleCount: 0, viewedCount: 0, fileCount: 0 };
}

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => { expect(fuzzyMatch("auth", "feat/auth")).not.toBeNull(); });
  it("rejects a non-subsequence", () => { expect(fuzzyMatch("zzz", "feat/auth")).toBeNull(); });
  it("empty query scores 0 (matches all)", () => { expect(fuzzyMatch("", "anything")).toBe(0); });
  it("is case-insensitive", () => { expect(fuzzyMatch("AUTH", "feat/auth")).not.toBeNull(); });
});

describe("rankReviews", () => {
  it("empty query sorts by lastOpenedAt desc", () => {
    const a = entry("a", "main", "demo", "2026-06-25T00:00:00Z");
    const b = entry("b", "feat", "demo", "2026-06-26T00:00:00Z");
    expect(rankReviews([a, b], "").map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("filters out non-matches", () => {
    const a = entry("a", "main", "demo", "t");
    const b = entry("b", "feat/auth", "demo", "t");
    expect(rankReviews([a, b], "auth").map((r) => r.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test fuzzy`
Expected: FAIL (`./fuzzy` not found).

- [ ] **Step 3: Implement**

```ts
// src/picker/fuzzy.ts
import type { ReviewEntry } from "../types";

/** Subsequence fuzzy match. Returns a score (higher is better), or null if no match. */
export function fuzzyMatch(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const consecutive = ti === prev + 1 ? 2 : 0;
      const boundary = ti === 0 || /[/\s_.-]/.test(t[ti - 1]) ? 3 : 0;
      score += 1 + consecutive + boundary;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** Filter + rank reviews against a query (branch + mode + repo name haystack). */
export function rankReviews(reviews: ReviewEntry[], query: string): ReviewEntry[] {
  const scored: { r: ReviewEntry; score: number }[] = [];
  for (const r of reviews) {
    const hay = `${r.target.worktree ?? ""} ${r.target.mode} ${r.repoName}`;
    const score = fuzzyMatch(query, hay);
    if (score !== null) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || b.r.lastOpenedAt.localeCompare(a.r.lastOpenedAt));
  return scored.map((x) => x.r);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test fuzzy`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/picker/fuzzy.ts src/picker/fuzzy.test.ts
git commit -m "feat(picker): fuzzy matcher + recency-aware review ranking"
```

---

### Task 12: Frontend — New review drill

**Files:**
- Create: `src/picker/NewReviewDrill.tsx`
- Create: `src/picker/NewReviewDrill.test.tsx`
- Modify: `src/dev/mockBackend.ts` (add `list_worktrees`, `import_repo`, `open_target` fixtures)

**Interfaces:**
- Consumes: `api.listWorktrees`, `api.importRepo`, `api.openTarget`; `RepoEntry`, `WorktreeEntry`, `DiffMode`.
- Produces: `NewReviewDrill({ repos, onClose, onReposChanged })` — three steps (repo → worktree → mode); single-worktree repos auto-advance; confirm calls `api.openTarget(worktree.path, mode)` then `onClose`.

- [ ] **Step 1: Add mock fixtures**

```ts
// src/dev/mockBackend.ts — add cases inside the switch (before `default:`)
      case "list_worktrees":
        return [
          { path: "/Users/me/projects/demo", branch: "feat/auth", isMain: true },
          { path: "/Users/me/projects/demo-main", branch: "main", isMain: false },
        ] as T;
      case "import_repo":
        return {
          id: "imported", root: "/Users/me/projects/imported", name: "imported",
          defaultBranch: "main",
          worktrees: [{ path: "/Users/me/projects/imported", branch: "main", isMain: true }],
        } as T;
      case "open_target":
        console.info("[delta mock] open_target", args);
        return undefined as T;
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/picker/NewReviewDrill.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewReviewDrill } from "./NewReviewDrill";
import { __setInvokeForDev } from "../api";
import type { RepoEntry } from "../types";

const repo: RepoEntry = {
  id: "r1", root: "/r/demo", name: "demo", defaultBranch: "main",
  worktrees: [{ path: "/r/demo", branch: "main", isMain: true }],
};

describe("NewReviewDrill", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_worktrees") return [{ path: "/r/demo", branch: "main", isMain: true }] as never;
      return undefined as never;
    });
  });

  it("single-worktree repo advances to mode and opens the target", async () => {
    render(<NewReviewDrill repos={[repo]} onClose={() => {}} onReposChanged={() => {}} />);
    fireEvent.click(screen.getByText("demo"));
    await waitFor(() => expect(screen.getByTestId("drill-modes")).toBeInTheDocument());
    fireEvent.click(screen.getByText("All changes"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
    const call = calls.find((c) => c.cmd === "open_target");
    expect(call?.args).toMatchObject({ repoPath: "/r/demo", mode: "all-changes" });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test NewReviewDrill`
Expected: FAIL (`./NewReviewDrill` not found).

- [ ] **Step 4: Implement**

```tsx
// src/picker/NewReviewDrill.tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DiffMode, RepoEntry, WorktreeEntry } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

type Step = "repo" | "worktree" | "mode";

function rove(e: React.KeyboardEvent, onEscape: () => void) {
  if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-item]"));
  const idx = items.findIndex((el) => el === document.activeElement);
  const next = e.key === "ArrowDown" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
  items[next < 0 ? 0 : next]?.focus();
}

export function NewReviewDrill({
  repos, onClose, onReposChanged,
}: { repos: RepoEntry[]; onClose: () => void; onReposChanged: () => void }) {
  const [step, setStep] = useState<Step>("repo");
  const [repo, setRepo] = useState<RepoEntry | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktree, setWorktree] = useState<WorktreeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("button[data-item]")?.focus();
  }, [step]);

  async function pickRepo(r: RepoEntry) {
    setError(null);
    setRepo(r);
    try {
      const wts = await api.listWorktrees(r.root);
      setWorktrees(wts);
      if (wts.length === 1) { setWorktree(wts[0]); setStep("mode"); }
      else { setStep("worktree"); }
    } catch (e) { setError(String(e)); }
  }

  async function doImport() {
    setError(null);
    try {
      const r = await api.importRepo();
      if (r) { onReposChanged(); await pickRepo(r); }
    } catch (e) { setError(String(e)); }
  }

  function pickWorktree(w: WorktreeEntry) { setWorktree(w); setStep("mode"); }

  async function pickMode(mode: DiffMode) {
    if (!worktree) return;
    setError(null);
    try { await api.openTarget(worktree.path, mode); onClose(); }
    catch (e) { setError(String(e)); }
  }

  return (
    <div data-testid="new-review-drill" className="absolute inset-0 z-10 flex items-start justify-center bg-background/80 pt-16 backdrop-blur-sm">
      <div className="w-[34rem] rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5 text-[12px] font-medium text-muted-foreground">
          <span>New review{repo ? ` · ${repo.name}` : ""}{step === "mode" && worktree ? ` · ${worktree.branch}` : ""}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>Cancel</button>
        </div>
        {error && <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">{error}</div>}
        <div ref={listRef} className="max-h-80 overflow-auto p-1.5" onKeyDown={(e) => rove(e, onClose)}>
          {step === "repo" && (
            <div data-testid="drill-repos" className="flex flex-col">
              {repos.map((r) => (
                <button key={r.id} data-item className="flex items-baseline gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => void pickRepo(r)}>
                  <span className="font-medium">{r.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{r.root}</span>
                </button>
              ))}
              <button data-item data-testid="drill-import" className="rounded-md px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => void doImport()}>
                Import…
              </button>
            </div>
          )}
          {step === "worktree" && (
            <div data-testid="drill-worktrees" className="flex flex-col">
              {worktrees.map((w) => (
                <button key={w.path} data-item className="flex items-baseline gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => pickWorktree(w)}>
                  <span className="font-medium">{w.branch}</span>
                  {w.isMain && <span className="text-[11px] text-muted-foreground">main worktree</span>}
                  <span className="truncate text-[11px] text-muted-foreground">{w.path}</span>
                </button>
              ))}
            </div>
          )}
          {step === "mode" && (
            <div data-testid="drill-modes" className="flex flex-col">
              {MODES.map((m) => (
                <button key={m.id} data-item className="rounded-md px-3 py-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => void pickMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test NewReviewDrill`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/picker/NewReviewDrill.tsx src/picker/NewReviewDrill.test.tsx src/dev/mockBackend.ts
git commit -m "feat(picker): new-review drill (repo -> worktree -> mode)"
```

---

### Task 13: Frontend — the Picker

**Files:**
- Create: `src/picker/Picker.tsx`
- Create: `src/picker/Picker.test.tsx`
- Modify: `src/dev/mockBackend.ts` (add `list_registry`, `delete_review`, `install_cli` fixtures)

**Interfaces:**
- Consumes: `api.listRegistry/openTarget/deleteReview/installCli`, `rankReviews`, `NewReviewDrill`; `Registry`, `ReviewEntry`, `InstallOutcome`.
- Produces: `Picker()` — search + recency rows + keyboard (`↑↓`/`↵`/`⌘N`/`⌘⌫`) + Install CLI footer + drill toggle.

- [ ] **Step 1: Add mock fixtures**

```ts
// src/dev/mockBackend.ts — add a REGISTRY const near the other fixtures
import type { /* existing */ Registry } from "../types";

const REGISTRY: Registry = {
  version: 1,
  repos: [{
    id: "r1", root: "/Users/me/projects/demo", name: "demo", defaultBranch: "main",
    worktrees: [
      { path: "/Users/me/projects/demo", branch: "feat/auth", isMain: true },
      { path: "/Users/me/projects/demo-main", branch: "main", isMain: false },
    ],
  }],
  reviews: [
    { id: "abc123", repoName: "demo", target: { repoPath: "/Users/me/projects/demo", worktree: "feat/auth", mode: "all-changes", base: "main" },
      lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 2, fileCount: 7 },
    { id: "def456", repoName: "demo", target: { repoPath: "/Users/me/projects/demo", worktree: "main", mode: "uncommitted" },
      lastOpenedAt: "2026-06-25T09:00:00Z", commentCount: 0, staleCount: 0, viewedCount: 0, fileCount: 2 },
  ],
};

// add cases inside the switch:
      case "list_registry":
        return structuredClone(REGISTRY) as T;
      case "delete_review":
        console.info("[delta mock] delete_review", args);
        return undefined as T;
      case "install_cli":
        return { kind: "linked", path: "/usr/local/bin/delta" } as T;
      case "show_picker":
        return undefined as T;
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/picker/Picker.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Picker } from "./Picker";
import { __setInvokeForDev } from "../api";
import type { Registry } from "../types";

const REG: Registry = {
  version: 1,
  repos: [{ id: "r1", root: "/r/demo", name: "demo", defaultBranch: "main", worktrees: [{ path: "/r/demo", branch: "main", isMain: true }] }],
  reviews: [
    { id: "abc", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 0, fileCount: 7 },
    { id: "def", repoName: "demo", target: { repoPath: "/r/demo", worktree: "main", mode: "uncommitted" }, lastOpenedAt: "2026-06-25T09:00:00Z", commentCount: 0, staleCount: 0, viewedCount: 0, fileCount: 2 },
  ],
};

describe("Picker", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_registry") return structuredClone(REG) as never;
      return undefined as never;
    });
  });

  it("renders recency-ordered rows and opens on Enter", async () => {
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    // first row (most recent) selected by default; Enter opens it
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_target")).toBe(true));
    expect(calls.find((c) => c.cmd === "open_target")?.args).toMatchObject({ repoPath: "/r/demo", mode: "all-changes" });
  });

  it("filters as you type", async () => {
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("feat/auth")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "uncommitted" } });
    await waitFor(() => expect(screen.queryByText("feat/auth")).not.toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test Picker`
Expected: FAIL (`./Picker` not found).

- [ ] **Step 4: Implement**

```tsx
// src/picker/Picker.tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { rankReviews } from "./fuzzy";
import { NewReviewDrill } from "./NewReviewDrill";
import { useSystemTheme } from "../theme";
import type { DiffMode, Registry, ReviewEntry } from "../types";

const MODE_LABEL: Record<DiffMode, string> = {
  "all-changes": "All changes",
  uncommitted: "Uncommitted",
  "last-commit": "Last commit",
  "branch-vs-base": "Branch vs base",
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function Picker() {
  useSystemTheme();
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  async function reload() {
    try { setRegistry(await api.listRegistry()); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => { void reload(); }, []);

  const rows = registry ? rankReviews(registry.reviews, query) : [];
  const clampedSel = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1);

  function openRow(r: ReviewEntry) {
    void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
  }
  async function deleteRow(r: ReviewEntry) {
    if (!confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) return;
    try { await api.deleteReview(r.id); await reload(); }
    catch (e) { setError(String(e)); }
  }
  async function install() {
    setError(null);
    try {
      const outcome = await api.installCli();
      setInstallMsg(outcome.kind === "linked" ? `Installed at ${outcome.path}` : `${outcome.reason}\n${outcome.command}`);
    } catch (e) { setError(String(e)); }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (drillOpen) return; // drill owns keys while open
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "Enter") { const r = rows[clampedSel]; if (r) openRow(r); }
      else if (e.key === "n" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setDrillOpen(true); }
      else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) { const r = rows[clampedSel]; if (r) void deleteRow(r); }
      else if (e.key === "Escape") { void api.hidePicker(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, clampedSel, drillOpen]);

  return (
    <div data-testid="picker-root" className="relative flex h-screen flex-col bg-background text-[13px] text-foreground">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center border-b border-border/70 pl-20 pr-3">
        <input
          autoFocus
          className="h-7 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:bg-background"
          placeholder="Search reviews…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
        />
      </header>
      {error && <div className="shrink-0 whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>}
      {installMsg && <div className="shrink-0 whitespace-pre-wrap border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{installMsg}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <p>{registry ? "No reviews yet" : "Loading…"}</p>
            <button className="rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted" onClick={() => setDrillOpen(true)}>＋ New review</button>
          </div>
        ) : (
          rows.map((r, i) => {
            const done = r.fileCount > 0 && r.viewedCount >= r.fileCount;
            return (
              <button
                key={r.id}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${i === clampedSel ? "bg-muted" : "hover:bg-muted/60"} ${done ? "opacity-55" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => openRow(r)}
              >
                <span className="font-medium">{r.target.worktree ?? "(detached)"}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{MODE_LABEL[r.target.mode]}</span>
                <span className="text-[12px] text-muted-foreground">{r.repoName}</span>
                <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
                  {r.commentCount > 0 && <span>💬 {r.commentCount}</span>}
                  {r.staleCount > 0 && <span className="text-amber-600">⚠ {r.staleCount}</span>}
                  <span>{relTime(r.lastOpenedAt)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t border-border/70 px-3 py-2 text-[12px] text-muted-foreground">
        <button className="hover:text-foreground" onClick={() => setDrillOpen(true)}>＋ New review <span className="opacity-60">⌘N</span></button>
        <button className="hover:text-foreground" onClick={() => void install()}>Install <code>delta</code> CLI</button>
      </footer>
      {drillOpen && (
        <NewReviewDrill
          repos={registry?.repos ?? []}
          onClose={() => setDrillOpen(false)}
          onReposChanged={() => void reload()}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test Picker`
Expected: PASS (2 tests). Then `pnpm test` (whole suite) green.

- [ ] **Step 6: Commit**

```bash
git add src/picker/Picker.tsx src/picker/Picker.test.tsx src/dev/mockBackend.ts
git commit -m "feat(picker): launch picker with search, recency rows, delete, install CLI"
```

---

### Task 14: Frontend — App router + Workspace de-stopgap + smoke test

**Files:**
- Modify: `src/App.tsx` (window-label router)
- Modify: `src/workspace/Workspace.tsx` (accept `target` prop; remove repo-path box; mode switch → `openTarget`; ⌘O)
- Modify: `src/smoke.test.tsx` (route-aware)

**Interfaces:**
- Consumes: `resolveRoute`, `getCurrentWindow().label`, `api.openTarget`, `api.showPicker`.
- Produces: `App` renders `<Picker/>` or `<Workspace target={...}/>` by window label; `Workspace({ target })`.

- [ ] **Step 1: Rewrite `App.tsx`**

```tsx
// src/App.tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Workspace } from "./workspace/Workspace";
import { Picker } from "./picker/Picker";
import { resolveRoute } from "./route";

function readLabel(): string | null {
  if (import.meta.env.VITE_MOCK_IPC) return null;
  try { return getCurrentWindow().label; } catch { return null; }
}

export default function App() {
  const route = resolveRoute(readLabel(), window.location.search);
  return route.kind === "review" ? <Workspace target={route.target} /> : <Picker />;
}
```

- [ ] **Step 2: De-stopgap `Workspace` — signature + state**

Replace the component signature and the stopgap state. Find:

```tsx
export function Workspace() {
  const theme = useSystemTheme();
  const [repoPath, setRepoPath] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("all-changes");
  const [summary, setSummary] = useState<DiffSummary | null>(null);
```

Replace with:

```tsx
export function Workspace({ target }: { target: Target }) {
  const theme = useSystemTheme();
  const mode = target.mode;
  const [summary, setSummary] = useState<DiffSummary | null>(null);
```

Add `Target` to the type import on line 11:

```tsx
import type { Anchor, Comment, DiffMode, DiffSummary, Target } from "../types";
```

- [ ] **Step 3: De-stopgap `Workspace` — open on target**

Find:

```tsx
  async function open(repo: string, m: DiffMode) {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: repo, mode: m });
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setReview(null);
    }
  }

  useEffect(() => {
    if (opened) void open(opened, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, mode]);
```

Replace with:

```tsx
  async function open() {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: target.repoPath, mode: target.mode, base: target.base });
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setReview(null);
    }
  }

  useEffect(() => {
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.repoPath, target.mode, target.base]);
```

- [ ] **Step 4: De-stopgap `Workspace` — header (remove input/Open, fix mode switch)**

Find the repo input + Open button + the `{opened && summary && (` guard:

```tsx
        <input
          className="h-7 w-60 rounded-md border border-input bg-muted/40 px-2.5 text-[13px] outline-none transition-[color,background-color] placeholder:text-muted-foreground/70 focus:bg-background"
          placeholder="Repo path"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setOpened(repoPath.trim() || null); }}
        />
        <Button size="sm" variant="secondary" className="h-7" onClick={() => setOpened(repoPath.trim() || null)}>Open</Button>
        {opened && summary && (
```

Replace with (show the repo name; mode switch opens/focuses the other mode's window):

```tsx
        <span className="text-[13px] font-medium">{target.repoPath.split("/").filter(Boolean).pop()}</span>
        {summary && (
```

Then find the mode `<select>` `onChange`:

```tsx
                onChange={(e) => setMode(e.target.value as DiffMode)}
```

Replace with:

```tsx
                onChange={(e) => void api.openTarget(target.repoPath, e.target.value as DiffMode, target.base ?? undefined)}
```

- [ ] **Step 5: De-stopgap `Workspace` — ⌘O + empty copy**

Find the keydown handler body opening:

```tsx
      if (e.key === "2" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIndexOpen((o) => !o);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
```

Insert a ⌘O branch before it:

```tsx
      if (e.key === "o" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void api.showPicker();
      } else if (e.key === "2" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIndexOpen((o) => !o);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
```

Find the empty-state copy:

```tsx
            <p className="text-[13px] text-muted-foreground">Open a repo to start a review</p>
```

Replace with:

```tsx
            <p className="text-[13px] text-muted-foreground">{error ? "Couldn’t open this review." : "Loading review…"}</p>
```

- [ ] **Step 6: Rewrite the smoke test (route-aware)**

```tsx
// src/smoke.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { __setInvokeForDev } from "./api";

describe("App routing", () => {
  beforeEach(() => {
    __setInvokeForDev(async (cmd) => {
      if (cmd === "list_registry") return { version: 1, repos: [], reviews: [] } as never;
      return undefined as never;
    });
    window.history.replaceState({}, "", "/");
  });

  it("renders the picker by default", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("picker-root")).toBeInTheDocument());
  });
});
```

- [ ] **Step 7: Run the suite**

Run: `pnpm test`
Expected: PASS (route, fuzzy, drill, picker, smoke, plus all Plan 2 tests). Also run `pnpm build` (`tsc && vite build`) and expect a clean type-check.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/workspace/Workspace.tsx src/smoke.test.tsx
git commit -m "feat(launch): route windows by label; de-stopgap the workspace"
```

---

### Task 15: Integration — mock end-to-end, behavioral + build sign-off

**Files:**
- Verify only (no new source) + a final mock sanity pass.

**Interfaces:** none (validation task).

- [ ] **Step 1: Full logic suites green**

Run: `pnpm test` and `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: both green.

- [ ] **Step 2: Picker behavior via the mock browser harness**

```bash
pnpm dev:mock   # serves on http://localhost:5599 (label → null → picker route)
```
Drive with preview MCP / agent-browser and confirm:
- Picker renders two recency-ordered rows (`feat/auth` first), `💬`/`⚠` chips, relative time.
- Typing `uncommitted` filters to the `main`/Uncommitted row; clearing restores both.
- `↑/↓` move the selection highlight; `⌘N` opens the drill; in the drill, the demo repo (two worktrees) advances **repo → worktree → mode**; choosing a mode logs `open_target`.
- Footer "Install delta CLI" shows the linked-path message.

- [ ] **Step 3: Workspace route via the mock**

Open `http://localhost:5599/?view=review&repo=/Users/me/projects/demo&mode=all-changes` and confirm the workspace renders the diff (existing Plan 2 behavior) with the repo name in the top bar and no repo-path box.

- [ ] **Step 4: Real multi-window + CLI sign-off (build-only)**

```bash
pnpm tauri build
```
With the built app, confirm by hand (these are not automatable in `dev:mock`):
- Launching the app icon shows the **picker** window.
- Opening a row creates a `review-<id>` window; opening the **same** target again focuses it (no duplicate).
- Opening two different targets yields two windows; `⌘O` from a review summons the picker; `Esc` hides it.
- `⌘⌫` on a row deletes it (file + registry) and closes its window if open.
- Install CLI: run it, then in a terminal `delta .` inside a repo opens/focuses that target; `delta` in a non-repo dir shows the picker; a second `delta <sameTarget>` focuses the existing window (single-instance).

- [ ] **Step 5: Final commit (docs + any fixups)**

```bash
git add -A
git commit -m "chore(launch): plan 3 integration verification"
```

---

## Self-Review

- **Spec coverage:**
  - §1/§2.1 multi-window → Tasks 7, 8, 14. §2.2 worktree=real-worktree → Task 3. §2.3 Install CLI → Task 9, 13.
  - §4 windows + seam + routing → Tasks 7 (seam), 8 (single-instance/setup), 10/14 (label routing).
  - §5 registry model/store/sync/rebuild → Tasks 1, 2, 4.
  - §6 picker + drill + commands → Tasks 5, 11, 12, 13.
  - §7 CLI parse/single-instance/install → Tasks 6, 8, 9.
  - §8 permissions/config → Task 8.
  - §10 verification → Tasks 1–15 (Rust unit, frontend logic, dev:mock, build sign-off).
- **Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output.
- **Type consistency:** `review-<id>` label, `open_target_window`, `ReviewEntry::from_review`, `rankReviews`, `resolveRoute`, `InstallOutcome` (Rust `kind` tag / TS union) consistent across tasks. `api.*` camelCase keys match Tauri's snake_case command params (auto-converted). `Target` gains no new fields (Plan 2 already added `worktree`/`base`).
- **Gaps fixed during review:** folded `hide_picker` (referenced by the Picker's `Esc`) into Task 7 (`launch::hide_picker` + command), Task 8 (registration), and Task 10 (`api.hidePicker`); added `Storage::delete` (Task 4) used by `delete_review_impl`.


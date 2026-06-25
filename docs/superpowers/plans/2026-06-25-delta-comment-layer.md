# delta — Plan 2: The Comment Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the comment layer on top of Plan 1's read-only diff viewer — per-target Review documents that persist comments (4 scopes) and viewed-state to local JSON, anchored against a frozen diff snapshot with Rust-side best-effort re-anchoring + per-comment staleness, an all-files scroll diff pane with inline comment widgets, a comment index, and a "Copy for Claude" markdown export.

**Architecture:** Rust owns the canonical model, the storage trait (atomic JSON), anchoring (`similar`), the reconcile pass (recompute diff → re-anchor → reset viewed → refresh snapshot), and the markdown serializer. The frontend holds the Review in memory as the session source of truth, mutates it (add/edit/delete comment, toggle viewed) and persists via `save_review`. One reconcile command (`open_review`/`refresh_review`) does all the heavy git/anchor work; the frontend lazy-loads per-file content (cached per session, cleared on refresh) and renders the all-files scroll. Anchors are 1-based file line numbers + a captured snippet, which map directly to git-diff-view's `lineNumber`+`SplitSide`.

**Tech Stack:** Rust + git2 (Plan 1) + `similar` (fuzzy match) + `sha2` (review id) + `chrono` (timestamps) + `serde_json`; React 19 + TS; `@git-diff-view/react`+`/file` 0.1.6 (pinned); `react-markdown`; shadcn/ui (dialog); vitest + happy-dom; the `VITE_MOCK_IPC` browser harness for behavioral verification.

## Global Constraints

- **Builds on Plan 1 (on `main`/feature branch).** Do not break existing commands `compute_diff`, `get_file_diff` or the `src/diff/` renderer boundary.
- **Renderer isolation:** only `src/diff/DiffView.tsx` imports `@git-diff-view/*`. `DiffPane` orchestrates layout but renders through `DiffView`.
- **Renderer version pinned:** `@git-diff-view/react` + `@git-diff-view/file` at exactly **0.1.6**.
- **Rust↔TS payloads are camelCase** (`#[serde(rename_all = "camelCase")]`); `CommentScope`/`Side` serialize **lowercase**; `DiffMode` stays **kebab-case** (Plan 1).
- **Comment scopes:** `line`, `range`, `file`, `general`. Markdown body only — no priority/label/type metadata.
- **Frontend owns mutations + whole-doc atomic save.** Comment ids = `crypto.randomUUID()`; comment `createdAt`/`updatedAt` = `new Date().toISOString()` (frontend). Rust stamps `snapshot.capturedAt`, `review.createdAt`, `review.lastOpenedAt`.
- **Review id** = first 16 hex chars of `SHA-256(repoPath \0 worktree \0 mode)`. Deterministic; no registry.
- **Anchors use 1-based file line numbers** on `new` (or `old`) side + a captured `snippet`. Fuzzy re-anchor window `W = 50` lines, similarity `THRESHOLD = 0.6`.
- **Frozen snapshot:** anchors/viewed reconcile only on `open_review`/`refresh_review`. Frontend caches `FileDiff` per session, cleared on Refresh. `refresh_review` takes the **in-memory** Review (race-free).
- **Nothing is ever written into the user's repo / working tree.** Reviews live in the app data dir.
- **Package manager is pnpm.** React 19 + React Compiler: **do not hand-write `useMemo`/`useCallback`/`React.memo`**.
- **Verification:** Rust = `export PATH="$HOME/.cargo/bin:$PATH" && cargo test` (in `src-tauri/`). Frontend logic = `pnpm test`. Frontend behavior = `pnpm dev:mock` (port 5599) + preview MCP / agent-browser (extend `src/dev/mockBackend.ts` fixtures per task). Human sign-off = `pnpm tauri dev`.
- **`registry.json`, the launch picker, and the CLI are out of scope** (Plan 3).

---

### Task 1: Rust — Review model, enriched Target, review-id hashing, deps

**Files:**
- Modify: `src-tauri/Cargo.toml` (add deps)
- Create: `src-tauri/src/review/mod.rs`
- Create: `src-tauri/src/review/model.rs`
- Modify: `src-tauri/src/git/model.rs` (add `worktree` to `Target`, `DiffMode::as_str`)
- Modify: `src-tauri/src/lib.rs` (add `mod review;`)

**Interfaces:**
- Consumes: `DiffMode` (Plan 1, `git::model`).
- Produces:
  - `git::model::Target` gains `pub worktree: Option<String>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`).
  - `DiffMode::as_str(&self) -> &'static str` (`"all-changes"|"uncommitted"|"last-commit"|"branch-vs-base"`).
  - `enum CommentScope { Line, Range, File, General }` (serde lowercase), `enum Side { New, Old }` (serde lowercase).
  - `struct Anchor { file: String, side: Side, start_line: Option<u32>, end_line: Option<u32>, snippet: Option<String> }` (camelCase).
  - `struct Comment { id: String, scope: CommentScope, anchor: Option<Anchor>, body: String, stale: bool, created_at: String, updated_at: String }` (camelCase).
  - `struct Snapshot { base_oid: String, head_oid: Option<String>, captured_at: String }` (camelCase).
  - `struct ViewedEntry { file: String, diff_hash: String }` (camelCase).
  - `struct Review { version: u32, id: String, target: Target, snapshot: Snapshot, comments: Vec<Comment>, viewed: Vec<ViewedEntry>, created_at: String, last_opened_at: String }` (camelCase); `Review::new(id, target, snapshot, now) -> Review`.
  - `fn review_id(repo_path: &str, worktree: &str, mode: DiffMode) -> String`.

- [ ] **Step 1: Add dependencies**

```toml
# src-tauri/Cargo.toml — under [dependencies] (keep existing git2, serde, tauri, etc.)
serde_json = "1"
sha2 = "0.10"
similar = "2"
chrono = { version = "0.4", features = ["clock"] }
```

(`serde_json` was a dev-dep in Plan 1; it must be a normal dependency now. Leave the `[dev-dependencies]` `serde_json`/`tempfile` entries as-is.)

- [ ] **Step 2: Write failing tests for `Target.worktree`, `DiffMode::as_str`, and `review_id`**

```rust
// add to the #[cfg(test)] mod tests in src-tauri/src/git/model.rs (create the test module if absent)
#[cfg(test)]
mod model_tests {
    use super::*;

    #[test]
    fn diffmode_as_str_is_kebab() {
        assert_eq!(DiffMode::AllChanges.as_str(), "all-changes");
        assert_eq!(DiffMode::BranchVsBase.as_str(), "branch-vs-base");
    }

    #[test]
    fn target_worktree_defaults_to_none_when_absent() {
        let t: Target = serde_json::from_str(r#"{"repoPath":"/r","mode":"uncommitted"}"#).unwrap();
        assert_eq!(t.worktree, None);
    }
}
```

```rust
// src-tauri/src/review/model.rs  (new) — failing test at the bottom
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::DiffMode;

    #[test]
    fn review_id_is_stable_16_hex() {
        let a = review_id("/Users/me/p", "main", DiffMode::AllChanges);
        let b = review_id("/Users/me/p", "main", DiffMode::AllChanges);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // mode participates in the key
        assert_ne!(a, review_id("/Users/me/p", "main", DiffMode::Uncommitted));
    }

    #[test]
    fn scope_and_side_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&CommentScope::Range).unwrap(), "\"range\"");
        assert_eq!(serde_json::to_string(&Side::New).unwrap(), "\"new\"");
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test review:: git::model::model_tests`
Expected: compile error / FAIL — `review` module + `as_str` + `worktree` not defined.

- [ ] **Step 4: Implement `Target.worktree` + `DiffMode::as_str`**

```rust
// src-tauri/src/git/model.rs — add worktree to Target
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub mode: DiffMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

impl DiffMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            DiffMode::AllChanges => "all-changes",
            DiffMode::Uncommitted => "uncommitted",
            DiffMode::LastCommit => "last-commit",
            DiffMode::BranchVsBase => "branch-vs-base",
        }
    }
}
```

(Any Plan 1 code constructing `Target { repo_path, mode, base }` must add `worktree: None`. Update those struct literals — `git/mod.rs` tests, `commands.rs` tests.)

- [ ] **Step 5: Implement the review model**

```rust
// src-tauri/src/review/mod.rs
pub mod model;
```

```rust
// src-tauri/src/review/model.rs  (above the test module)
use crate::git::model::{DiffMode, Target};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentScope {
    Line,
    Range,
    File,
    General,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    New,
    Old,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub file: String,
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub scope: CommentScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    pub body: String,
    #[serde(default)]
    pub stale: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub base_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewedEntry {
    pub file: String,
    pub diff_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub version: u32,
    pub id: String,
    pub target: Target,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub viewed: Vec<ViewedEntry>,
    pub created_at: String,
    pub last_opened_at: String,
}

impl Review {
    pub fn new(id: String, target: Target, snapshot: Snapshot, now: String) -> Self {
        Review {
            version: 1,
            id,
            target,
            snapshot,
            comments: Vec::new(),
            viewed: Vec::new(),
            created_at: now.clone(),
            last_opened_at: now,
        }
    }
}

/// Stable review id: first 16 hex chars of SHA-256(repoPath \0 worktree \0 mode).
pub fn review_id(repo_path: &str, worktree: &str, mode: DiffMode) -> String {
    let mut h = Sha256::new();
    h.update(repo_path.as_bytes());
    h.update([0]);
    h.update(worktree.as_bytes());
    h.update([0]);
    h.update(mode.as_str().as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}
```

```rust
// src-tauri/src/lib.rs — add near the other `mod` lines
mod review;
```

- [ ] **Step 6: Run to verify pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test`
Expected: PASS (new tests + all Plan 1 tests still green).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(review): review/comment/anchor model, enriched Target, review-id hashing"
```

---

### Task 2: Rust — Storage trait + atomic JSON impl

**Files:**
- Create: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod storage;`)

**Interfaces:**
- Consumes: `Review` (Task 1).
- Produces:
  - `trait Storage { fn load(&self, id: &str) -> Result<Option<Review>, String>; fn save(&self, review: &Review) -> Result<(), String>; }`
  - `struct JsonStorage { root: PathBuf }` with `JsonStorage::new(root: PathBuf) -> Self` (root = the `reviews/` dir); implements `Storage` with atomic temp-file+rename writes.

- [ ] **Step 1: Write failing round-trip + atomic tests**

```rust
// src-tauri/src/storage/mod.rs  (test module at bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Review, Snapshot};
    use tempfile::TempDir;

    fn sample() -> Review {
        let target = Target { repo_path: "/r".into(), worktree: Some("main".into()), mode: DiffMode::AllChanges, base: None };
        Review::new("abc123".into(), target, Snapshot { base_oid: "b".into(), head_oid: None, captured_at: "t".into() }, "t".into())
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        let s = JsonStorage::new(dir.path().join("reviews"));
        assert!(s.load("nope").unwrap().is_none());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = TempDir::new().unwrap();
        let s = JsonStorage::new(dir.path().join("reviews"));
        let r = sample();
        s.save(&r).unwrap();
        let loaded = s.load("abc123").unwrap().unwrap();
        assert_eq!(loaded.id, "abc123");
        assert_eq!(loaded.target.worktree.as_deref(), Some("main"));
    }

    #[test]
    fn save_leaves_no_tmp_file() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("reviews");
        let s = JsonStorage::new(root.clone());
        s.save(&sample()).unwrap();
        let entries: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(entries, vec!["abc123.json".to_string()]);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test storage::`
Expected: FAIL — `storage` module not defined.

- [ ] **Step 3: Implement the storage trait + JSON impl**

```rust
// src-tauri/src/storage/mod.rs  (above the test module)
use crate::review::model::Review;
use std::fs;
use std::path::PathBuf;

pub trait Storage {
    fn load(&self, id: &str) -> Result<Option<Review>, String>;
    fn save(&self, review: &Review) -> Result<(), String>;
}

pub struct JsonStorage {
    root: PathBuf,
}

impl JsonStorage {
    /// `root` is the directory holding `<id>.json` files (e.g. <app_data>/reviews).
    pub fn new(root: PathBuf) -> Self {
        JsonStorage { root }
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
}

impl Storage for JsonStorage {
    fn load(&self, id: &str) -> Result<Option<Review>, String> {
        let path = self.path_for(id);
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("parse review {id}: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read review {id}: {e}")),
        }
    }

    fn save(&self, review: &Review) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| format!("create reviews dir: {e}"))?;
        let text = serde_json::to_string_pretty(review).map_err(|e| format!("serialize review: {e}"))?;
        let final_path = self.path_for(&review.id);
        let tmp_path = self.root.join(format!("{}.json.tmp", review.id));
        fs::write(&tmp_path, text.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        fs::rename(&tmp_path, &final_path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}
```

```rust
// src-tauri/src/lib.rs — add
mod storage;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test storage::`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(storage): Storage trait + atomic JSON review persistence"
```

---

### Task 3: Rust — Anchoring service (exact + fuzzy + staleness) + diffHash

**Files:**
- Create: `src-tauri/src/anchor/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod anchor;`)

**Interfaces:**
- Consumes: `Anchor`, `Side` (Task 1).
- Produces:
  - `fn diff_hash(old: &str, new: &str) -> String` (first 16 hex of `SHA-256(old \0 new)`).
  - `fn reanchor(start_line: u32, snippet: &str, content: &str) -> Option<(u32, Option<u32>)>` — returns the new 1-based `(start_line, end_line)` for a `snippet`-length block (exact at `start_line`, else best fuzzy match within `±W`), or `None` (→ stale). `end_line` is `Some` only for multi-line snippets.
  - consts `WINDOW: u32 = 50`, `THRESHOLD: f32 = 0.6`.

- [ ] **Step 1: Write failing tests**

```rust
// src-tauri/src/anchor/mod.rs  (test module at bottom)
#[cfg(test)]
mod tests {
    use super::*;

    const CONTENT: &str = "fn a() {}\nlet x = 1;\nlet y = 2;\nfn b() {}\n";

    #[test]
    fn exact_match_keeps_position() {
        // "let x = 1;" is line 2 (1-based)
        assert_eq!(reanchor(2, "let x = 1;", CONTENT), Some((2, None)));
    }

    #[test]
    fn fuzzy_finds_shifted_line() {
        // snippet moved down: insert two lines before it
        let shifted = "// added\n// added2\nfn a() {}\nlet x = 1;\nlet y = 2;\n";
        // originally line 2, now line 4
        assert_eq!(reanchor(2, "let x = 1;", shifted), Some((4, None)));
    }

    #[test]
    fn fuzzy_tolerates_small_edit() {
        let edited = "fn a() {}\nlet x = 10;\nlet y = 2;\n"; // "let x = 1;" -> "let x = 10;"
        assert_eq!(reanchor(2, "let x = 1;", edited), Some((2, None)));
    }

    #[test]
    fn no_match_returns_none() {
        let gone = "totally\ndifferent\ncontent\nhere\n";
        assert_eq!(reanchor(2, "let x = 1;", gone), None);
    }

    #[test]
    fn multiline_snippet_returns_end_line() {
        // two-line snippet at lines 2-3
        assert_eq!(reanchor(2, "let x = 1;\nlet y = 2;", CONTENT), Some((2, Some(3))));
    }

    #[test]
    fn diff_hash_changes_with_content() {
        assert_ne!(diff_hash("a", "b"), diff_hash("a", "c"));
        assert_eq!(diff_hash("a", "b"), diff_hash("a", "b"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test anchor::`
Expected: FAIL — `anchor` module not defined.

- [ ] **Step 3: Implement anchoring**

```rust
// src-tauri/src/anchor/mod.rs  (above the test module)
use sha2::{Digest, Sha256};
use similar::TextDiff;

pub const WINDOW: u32 = 50;
pub const THRESHOLD: f32 = 0.6;

pub fn diff_hash(old: &str, new: &str) -> String {
    let mut h = Sha256::new();
    h.update(old.as_bytes());
    h.update([0]);
    h.update(new.as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}

/// Similarity in [0,1] between two multi-line blocks.
fn ratio(a: &str, b: &str) -> f32 {
    TextDiff::from_lines(a, b).ratio()
}

/// Re-anchor a `snippet` (1+ lines) that was last at 1-based `start_line` within `content`.
/// Returns the new (start_line, end_line) — end_line Some only for multi-line snippets —
/// or None if nothing within ±WINDOW matches above THRESHOLD.
pub fn reanchor(start_line: u32, snippet: &str, content: &str) -> Option<(u32, Option<u32>)> {
    let lines: Vec<&str> = content.lines().collect();
    let snippet_lines: Vec<&str> = snippet.lines().collect();
    let span = snippet_lines.len().max(1);
    if lines.is_empty() {
        return None;
    }

    let block_at = |start_idx: usize| -> Option<String> {
        if start_idx + span <= lines.len() {
            Some(lines[start_idx..start_idx + span].join("\n"))
        } else {
            None
        }
    };
    let to_result = |start_idx: usize| -> (u32, Option<u32>) {
        let start = (start_idx as u32) + 1;
        let end = if span > 1 { Some(start + span as u32 - 1) } else { None };
        (start, end)
    };

    // 1) exact at the recorded line
    let orig_idx = start_line.saturating_sub(1) as usize;
    if let Some(block) = block_at(orig_idx) {
        if block == snippet {
            return Some(to_result(orig_idx));
        }
    }

    // 2) best fuzzy match within ±WINDOW
    let lo = start_line.saturating_sub(WINDOW).saturating_sub(1) as usize;
    let hi = ((start_line + WINDOW) as usize).min(lines.len());
    let mut best: Option<(f32, usize)> = None;
    for idx in lo..hi {
        if let Some(block) = block_at(idx) {
            let r = ratio(&block, snippet);
            if best.map(|(br, _)| r > br).unwrap_or(true) {
                best = Some((r, idx));
            }
        }
    }
    match best {
        Some((r, idx)) if r >= THRESHOLD => Some(to_result(idx)),
        _ => None,
    }
}
```

```rust
// src-tauri/src/lib.rs — add
mod anchor;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test anchor::`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(anchor): exact+fuzzy snippet re-anchoring and diff hashing"
```

---

### Task 4: Rust — Reconcile pass (open/refresh core)

**Files:**
- Create: `src-tauri/src/review/reconcile.rs`
- Modify: `src-tauri/src/review/mod.rs` (add `pub mod reconcile;`)
- Modify: `src-tauri/src/git/mod.rs` (add `pub fn resolve_worktree`)

**Interfaces:**
- Consumes: `open_repo`, `resolve_endpoints`, `Endpoints`, `RightSide` (Plan 1); `compute_diff`, `get_file_diff`, `DiffSummary` (Plan 1); `Review`, `Anchor`, `Side`, `Snapshot`, `review_id` (Task 1); `reanchor`, `diff_hash` (Task 3).
- Produces:
  - `git::resolve_worktree(repo: &Repository) -> Result<String, GitError>` (branch shorthand, else short OID).
  - `struct ReviewSession { review: Review, summary: DiffSummary }` (camelCase) — define in `review::reconcile`.
  - `fn reconcile(mut review: Review) -> Result<ReviewSession, GitError>` — re-resolves worktree+id, recomputes the diff, re-anchors comments, resets viewed by `diff_hash`, refreshes the snapshot + `last_opened_at`.

- [ ] **Step 1: Implement `resolve_worktree` (with test)**

```rust
// src-tauri/src/git/mod.rs — add function
pub fn resolve_worktree(repo: &Repository) -> Result<String, GitError> {
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    if let Some(name) = head.shorthand() {
        if name != "HEAD" {
            return Ok(name.to_string());
        }
    }
    let oid = head.peel_to_commit().map_err(|e| format!("head commit: {e}"))?.id();
    Ok(oid.to_string().chars().take(7).collect())
}
```

```rust
// add to the #[cfg(test)] mod tests in src-tauri/src/git/mod.rs
#[test]
fn resolve_worktree_returns_branch_name() {
    let (_dir, repo) = test_support::repo_with_commit();
    assert_eq!(resolve_worktree(&repo).unwrap(), "main");
}
```

- [ ] **Step 2: Write failing reconcile tests**

```rust
// src-tauri/src/review/reconcile.rs  (test module at bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot, ViewedEntry};

    fn empty_review(repo_path: &str) -> Review {
        let target = Target { repo_path: repo_path.into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
        Review::new("id".into(), target, Snapshot { base_oid: "".into(), head_oid: None, captured_at: "".into() }, "t".into())
    }

    fn line_comment(file: &str, line: u32, snippet: &str) -> Comment {
        Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: Some(Anchor { file: file.into(), side: Side::New, start_line: Some(line), end_line: None, snippet: Some(snippet.into()) }),
            body: "b".into(),
            stale: false,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn reanchors_moved_comment_and_clears_stale() {
        let (dir, _repo) = repo_with_commit(); // file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "inserted\nline1\nline2\n"); // line1 moved 1->2
        let mut r = empty_review(dir.path().to_str().unwrap());
        let mut c = line_comment("file.txt", 1, "line1");
        c.stale = true;
        r.comments.push(c);
        let session = reconcile(r).unwrap();
        let a = session.review.comments[0].anchor.as_ref().unwrap();
        assert_eq!(a.start_line, Some(2));
        assert_eq!(session.review.comments[0].stale, false);
    }

    #[test]
    fn marks_stale_when_snippet_gone() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "completely\ndifferent\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.comments.push(line_comment("file.txt", 1, "line1"));
        let session = reconcile(r).unwrap();
        assert_eq!(session.review.comments[0].stale, true);
    }

    #[test]
    fn keeps_viewed_when_diff_unchanged_drops_when_changed() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\n");
        // capture the current diff hash for file.txt by reconciling once
        let mut r = empty_review(dir.path().to_str().unwrap());
        let first = reconcile(r.clone()).unwrap();
        // mark viewed with the correct current hash
        let fd = crate::git::diff::get_file_diff(&first.review.target, "file.txt").unwrap();
        let h = crate::anchor::diff_hash(fd.old_content.as_deref().unwrap_or(""), fd.new_content.as_deref().unwrap_or(""));
        r = first.review;
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: h });
        let kept = reconcile(r.clone()).unwrap();
        assert_eq!(kept.review.viewed.len(), 1);
        // now change the file -> viewed should drop
        write(dir.path(), "file.txt", "line1\nCHANGED-AGAIN\n");
        let dropped = reconcile(r).unwrap();
        assert_eq!(dropped.review.viewed.len(), 0);
    }
}
```

(`Review` needs `#[derive(Clone)]` — already added in Task 1.)

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test review::reconcile`
Expected: FAIL — `reconcile` not defined.

- [ ] **Step 4: Implement reconcile**

```rust
// src-tauri/src/review/reconcile.rs  (above the test module)
use crate::anchor::{diff_hash, reanchor};
use crate::git::diff::{compute_diff, get_file_diff, DiffSummary};
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, resolve_worktree, GitError, RightSide};
use crate::review::model::{review_id, Review, Side, Snapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub review: Review,
    pub summary: DiffSummary,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Reconcile a review against the current repo state: re-resolve worktree/id,
/// recompute the diff, re-anchor comments (best-effort, else stale), reset viewed
/// where the file's diff changed, and refresh the snapshot.
pub fn reconcile(mut review: Review) -> Result<ReviewSession, GitError> {
    let repo = open_repo(&review.target.repo_path)?;
    let worktree = resolve_worktree(&repo)?;
    review.target.worktree = Some(worktree.clone());
    review.id = review_id(&review.target.repo_path, &worktree, review.target.mode);

    let summary = compute_diff(&review.target)?;
    let present: std::collections::HashSet<&str> = summary.files.iter().map(|f| f.path.as_str()).collect();

    // Re-anchor comments.
    let target = review.target.clone();
    for comment in &mut review.comments {
        let Some(anchor) = comment.anchor.as_mut() else { continue }; // general note
        let has_lines = anchor.start_line.is_some() && anchor.snippet.is_some();
        if !has_lines {
            // file-scope: present in diff => fresh, else stale
            comment.stale = !present.contains(anchor.file.as_str());
            continue;
        }
        let content = file_side_content(&target, &anchor.file, anchor.side);
        match content {
            Some(content) => {
                match reanchor(anchor.start_line.unwrap(), anchor.snippet.as_deref().unwrap(), &content) {
                    Some((start, end)) => {
                        anchor.start_line = Some(start);
                        anchor.end_line = end;
                        comment.stale = false;
                    }
                    None => comment.stale = true,
                }
            }
            None => comment.stale = true, // file removed from diff or binary
        }
    }

    // Reset viewed entries whose file diff changed (or vanished).
    review.viewed.retain(|v| match get_file_diff(&target, &v.file) {
        Ok(fd) => diff_hash(fd.old_content.as_deref().unwrap_or(""), fd.new_content.as_deref().unwrap_or("")) == v.diff_hash,
        Err(_) => false,
    });

    // Refresh snapshot.
    let ep = resolve_endpoints(&repo, &review.target)?;
    review.snapshot = Snapshot {
        base_oid: ep.from_tree.map(|o| o.to_string()).unwrap_or_default(),
        head_oid: match ep.right {
            RightSide::Tree(o) => Some(o.to_string()),
            RightSide::WorkTree => None,
        },
        captured_at: now(),
    };
    review.last_opened_at = now();

    Ok(ReviewSession { review, summary })
}

fn file_side_content(target: &Target, file: &str, side: Side) -> Option<String> {
    let fd = get_file_diff(target, file).ok()?;
    match side {
        Side::New => fd.new_content,
        Side::Old => fd.old_content,
    }
}
```

```rust
// src-tauri/src/review/mod.rs — add
pub mod reconcile;
```

- [ ] **Step 5: Run to verify pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test`
Expected: PASS (all, including 3 reconcile + 1 worktree test).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(review): reconcile pass — re-anchor, viewed reset, snapshot refresh"
```

---

### Task 5: Rust — Markdown serializer ("Copy for Claude")

**Files:**
- Create: `src-tauri/src/export/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod export;`)

**Interfaces:**
- Consumes: `Review`, `Comment`, `CommentScope`, `Side`, `Anchor` (Task 1).
- Produces: `fn export_markdown(review: &Review) -> String` — spec §11 format: self-describing header; General section first; then grouped by file; each comment = location header + fenced snippet + body; stale marked `⚠ stale`.

- [ ] **Step 1: Write failing golden-ish tests**

```rust
// src-tauri/src/export/mod.rs  (test module at bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot};

    fn review_with(comments: Vec<Comment>) -> Review {
        let target = Target { repo_path: "/r".into(), worktree: Some("feat/auth".into()), mode: DiffMode::BranchVsBase, base: Some("main".into()) };
        let mut r = Review::new("id".into(), target, Snapshot { base_oid: "a1b2c3d".into(), head_oid: Some("e4f5g6h".into()), captured_at: "2026-06-25T18:54:00Z".into() }, "t".into());
        r.comments = comments;
        r
    }

    fn cmt(scope: CommentScope, anchor: Option<Anchor>, body: &str, stale: bool) -> Comment {
        Comment { id: "x".into(), scope, anchor, body: body.into(), stale, created_at: "t".into(), updated_at: "t".into() }
    }

    #[test]
    fn general_section_comes_first() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("export const TTL = 3600".into()) }), "make configurable", false),
            cmt(CommentScope::General, None, "standardize errors", false),
        ]));
        let general_pos = md.find("## General").unwrap();
        let file_pos = md.find("## src/a.ts").unwrap();
        assert!(general_pos < file_pos, "General must precede file sections");
        assert!(md.contains("standardize errors"));
    }

    #[test]
    fn line_comment_has_location_snippet_and_body() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("export const TTL = 3600".into()) }), "make configurable", false),
        ]));
        assert!(md.contains("#### L40"));
        assert!(md.contains("```ts"));
        assert!(md.contains("export const TTL = 3600"));
        assert!(md.contains("make configurable"));
    }

    #[test]
    fn stale_is_marked_not_dropped() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::Old, start_line: Some(8), end_line: None, snippet: Some("if (!token) return null".into()) }), "redundant guard", true),
        ]));
        assert!(md.contains("⚠ stale"));
        assert!(md.contains("redundant guard"));
        assert!(md.contains("old-side"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test export::`
Expected: FAIL — `export_markdown` not defined.

- [ ] **Step 3: Implement the serializer**

```rust
// src-tauri/src/export/mod.rs  (above the test module)
use crate::git::lang::lang_for;
use crate::review::model::{Comment, CommentScope, Review, Side};
use std::collections::BTreeMap;

pub fn export_markdown(review: &Review) -> String {
    let mut out = String::new();
    let t = &review.target;
    let worktree = t.worktree.as_deref().unwrap_or("");
    out.push_str(&format!("# Review — {} · {} · {}\n", t.repo_path, worktree, t.mode.as_str()));
    let head = review.snapshot.head_oid.as_deref().unwrap_or("working tree");
    out.push_str(&format!("Base {} ⇢ head {} · captured {}\n\n", review.snapshot.base_oid, head, review.snapshot.captured_at));

    // General first.
    let generals: Vec<&Comment> = review.comments.iter().filter(|c| c.scope == CommentScope::General).collect();
    if !generals.is_empty() {
        out.push_str("## General\n");
        for c in generals {
            out.push_str(&format!("- {}{}\n", stale_tag(c), c.body.trim()));
        }
        out.push('\n');
    }

    // Group the rest by file, preserving anchored line order.
    let mut by_file: BTreeMap<String, Vec<&Comment>> = BTreeMap::new();
    for c in review.comments.iter().filter(|c| c.scope != CommentScope::General) {
        if let Some(a) = &c.anchor {
            by_file.entry(a.file.clone()).or_default().push(c);
        }
    }
    for (file, mut comments) in by_file {
        comments.sort_by_key(|c| c.anchor.as_ref().and_then(|a| a.start_line).unwrap_or(0));
        out.push_str(&format!("## {file}\n\n"));
        let lang = lang_for(&file).unwrap_or_default();
        for c in comments {
            let a = c.anchor.as_ref().unwrap();
            let header = match c.scope {
                CommentScope::File => "#### File-level".to_string(),
                CommentScope::Range => match (a.start_line, a.end_line) {
                    (Some(s), Some(e)) => format!("#### L{s}–{e}"),
                    (Some(s), _) => format!("#### L{s}"),
                    _ => "#### File-level".to_string(),
                },
                _ => a.start_line.map(|s| format!("#### L{s}")).unwrap_or_else(|| "#### File-level".to_string()),
            };
            let side_note = if a.side == Side::Old { " · old-side" } else { "" };
            out.push_str(&format!("{header}{side_note}{}\n", stale_suffix(c)));
            if let Some(snippet) = &a.snippet {
                out.push_str(&format!("```{lang}\n{}\n```\n", snippet.trim_end()));
            }
            out.push_str(&format!("{}\n\n", c.body.trim()));
        }
    }

    out
}

fn stale_tag(c: &Comment) -> &'static str {
    if c.stale { "⚠ stale — " } else { "" }
}

fn stale_suffix(c: &Comment) -> &'static str {
    if c.stale { " · ⚠ stale" } else { "" }
}
```

(`lang_for` is `pub` in `git/lang.rs` from Plan 1; if it is not `pub`, make it `pub`.)

```rust
// src-tauri/src/lib.rs — add
mod export;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test export::`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(export): markdown serializer for Copy for Claude"
```

---

### Task 6: Rust — Tauri commands (open/refresh/save/export) + registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (add 4 commands + `_impl` fns)
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: `Storage`, `JsonStorage` (Task 2); `reconcile`, `ReviewSession` (Task 4); `export_markdown` (Task 5); `Review`, `review_id`, `Snapshot` (Task 1); `open_repo`, `resolve_worktree` (Plan 1/Task 4); `Target` (Plan 1).
- Produces (invoke API):
  - `open_review(target: Target) -> Result<ReviewSession, String>` — load-or-create by id, reconcile, persist.
  - `refresh_review(review: Review) -> Result<ReviewSession, String>` — reconcile the in-memory review, persist.
  - `save_review(review: Review) -> Result<(), String>` — atomic write.
  - `export_review(review: Review) -> Result<String, String>` — markdown.

- [ ] **Step 1: Write a failing test for `open_review_impl` (load-or-create + reconcile + persist)**

```rust
// add to the #[cfg(test)] mod tests in src-tauri/src/commands.rs
#[test]
fn open_review_impl_creates_persists_and_reanchors() {
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::storage::{JsonStorage, Storage};

    let (dir, _repo) = repo_with_commit();
    write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
    let store_dir = tempfile::TempDir::new().unwrap();
    let storage = JsonStorage::new(store_dir.path().join("reviews"));

    let target = Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None };
    let session = open_review_impl(&storage, target).unwrap();

    assert!(session.summary.files.iter().any(|f| f.path == "file.txt"));
    assert_eq!(session.review.target.worktree.as_deref(), Some("main"));
    // persisted under the deterministic id
    let loaded = storage.load(&session.review.id).unwrap();
    assert!(loaded.is_some());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test commands`
Expected: FAIL — `open_review_impl` not defined.

- [ ] **Step 3: Implement the `_impl` fns + commands**

```rust
// src-tauri/src/commands.rs — add near the top (keep Plan 1 imports + commands)
use crate::export::export_markdown;
use crate::git::model::Target;
use crate::git::{open_repo, resolve_worktree};
use crate::review::model::{review_id, Review, Snapshot};
use crate::review::reconcile::{reconcile, ReviewSession};
use crate::storage::{JsonStorage, Storage};
use std::path::PathBuf;
use tauri::Manager;

fn reviews_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("reviews"))
}

pub fn open_review_impl(storage: &dyn Storage, input: Target) -> Result<ReviewSession, String> {
    let repo = open_repo(&input.repo_path)?;
    let worktree = resolve_worktree(&repo)?;
    let mut target = input;
    target.worktree = Some(worktree.clone());
    let id = review_id(&target.repo_path, &worktree, target.mode);

    let review = match storage.load(&id)? {
        Some(r) => r,
        None => Review::new(
            id,
            target,
            Snapshot { base_oid: String::new(), head_oid: None, captured_at: String::new() },
            chrono::Utc::now().to_rfc3339(),
        ),
    };
    let session = reconcile(review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn refresh_review_impl(storage: &dyn Storage, review: Review) -> Result<ReviewSession, String> {
    let session = reconcile(review)?;
    storage.save(&session.review)?;
    Ok(session)
}

#[tauri::command]
pub fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    open_review_impl(&storage, target)
}

#[tauri::command]
pub fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    refresh_review_impl(&storage, review)
}

#[tauri::command]
pub fn save_review(app: tauri::AppHandle, review: Review) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    storage.save(&review)
}

#[tauri::command]
pub fn export_review(review: Review) -> Result<String, String> {
    Ok(export_markdown(&review))
}
```

- [ ] **Step 4: Register the commands**

```rust
// src-tauri/src/lib.rs — extend the invoke_handler list
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review
        ])
```

- [ ] **Step 5: Run to verify pass + build**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test && cargo build`
Expected: tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(commands): open/refresh/save/export review Tauri commands"
```

---

### Task 7: Frontend — review types, api client, mock fixtures

**Files:**
- Modify: `src/types.ts` (add review types; `Target.worktree`)
- Modify: `src/api.ts` (add 4 methods)
- Modify: `src/api.test.ts` (cover new methods)
- Modify: `src/dev/mockBackend.ts` (add open/refresh/save/export fixtures)

**Interfaces:**
- Consumes: the command names + payload shapes (Task 6).
- Produces:
  - TS types `CommentScope`, `Side`, `Anchor`, `Comment`, `Snapshot`, `ViewedEntry`, `Review`, `ReviewSession`; `Target.worktree?`.
  - `api.openReview(target)`, `api.refreshReview(review)`, `api.saveReview(review)`, `api.exportReview(review)`.

- [ ] **Step 1: Write failing api tests**

```ts
// src/api.test.ts — add inside describe("api", ...)
it("openReview calls open_review with the target", async () => {
  const target = { repoPath: "/r", mode: "all-changes" as const };
  invokeMock.mockResolvedValue({ review: { id: "x" }, summary: { files: [], baseLabel: "main", headLabel: "h" } });
  const res = await api.openReview(target);
  expect(invokeMock).toHaveBeenCalledWith("open_review", { target });
  expect(res.review.id).toBe("x");
});

it("saveReview and exportReview pass the review", async () => {
  const review = { id: "x" } as any;
  invokeMock.mockResolvedValue(undefined);
  await api.saveReview(review);
  expect(invokeMock).toHaveBeenCalledWith("save_review", { review });
  invokeMock.mockResolvedValue("# md");
  const md = await api.exportReview(review);
  expect(invokeMock).toHaveBeenCalledWith("export_review", { review });
  expect(md).toBe("# md");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/api.test.ts`
Expected: FAIL — `api.openReview` not defined.

- [ ] **Step 3: Add the types**

```ts
// src/types.ts — add (and add `worktree?: string | null;` to the Target interface)
export type CommentScope = "line" | "range" | "file" | "general";
export type Side = "new" | "old";

export interface Anchor {
  file: string;
  side: Side;
  startLine?: number | null;
  endLine?: number | null;
  snippet?: string | null;
}

export interface Comment {
  id: string;
  scope: CommentScope;
  anchor?: Anchor | null;
  body: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  baseOid: string;
  headOid?: string | null;
  capturedAt: string;
}

export interface ViewedEntry {
  file: string;
  diffHash: string;
}

export interface Review {
  version: number;
  id: string;
  target: Target;
  snapshot: Snapshot;
  comments: Comment[];
  viewed: ViewedEntry[];
  createdAt: string;
  lastOpenedAt: string;
}

export interface ReviewSession {
  review: Review;
  summary: DiffSummary;
}
```

- [ ] **Step 4: Add the api methods**

```ts
// src/api.ts — add to the `api` object; import the new types
import type { Target, DiffSummary, FileDiff, Review, ReviewSession } from "./types";
// ...
export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> => invokeImpl("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> => invokeImpl("get_file_diff", { target, path }),
  openReview: (target: Target): Promise<ReviewSession> => invokeImpl("open_review", { target }),
  refreshReview: (review: Review): Promise<ReviewSession> => invokeImpl("refresh_review", { review }),
  saveReview: (review: Review): Promise<void> => invokeImpl("save_review", { review }),
  exportReview: (review: Review): Promise<string> => invokeImpl("export_review", { review }),
};
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test src/api.test.ts`
Expected: PASS.

- [ ] **Step 6: Extend the mock backend with review fixtures**

```ts
// src/dev/mockBackend.ts — add fixtures + handlers. Import the review types.
import type { DiffSummary, FileDiff, Review, ReviewSession } from "../types";

const REVIEW: Review = {
  version: 1,
  id: "mockid",
  target: { repoPath: "/Users/me/projects/demo", worktree: "feat/auth", mode: "all-changes" },
  snapshot: { baseOid: "a1b2c3d", headOid: null, capturedAt: "2026-06-25T18:54:00Z" },
  comments: [
    {
      id: "c1", scope: "line",
      anchor: { file: "src/auth/session.ts", side: "new", startLine: 3, endLine: null, snippet: "  return store.read(user.id)" },
      body: "Use the store, not the cache.", stale: false,
      createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z",
    },
    {
      id: "c2", scope: "general", anchor: null,
      body: "Standardize error handling across `auth/`.", stale: false,
      createdAt: "2026-06-25T18:51:00Z", updatedAt: "2026-06-25T18:51:00Z",
    },
  ],
  viewed: [],
  createdAt: "2026-06-25T18:50:00Z", lastOpenedAt: "2026-06-25T18:54:00Z",
};

// inside installMockBackend's switch, add:
//   case "open_review":
//   case "refresh_review":
//     return { review: REVIEW, summary: SUMMARY } as T;
//   case "save_review":
//     return undefined as T;
//   case "export_review":
//     return "# Review — demo · feat/auth · All changes\n\n## General\n- Standardize error handling.\n" as T;
```

Wire those cases into the existing `switch (cmd)` in `installMockBackend`, returning the `ReviewSession`/string shapes above.

- [ ] **Step 7: Verify typecheck + tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: tsc exit 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(ui): review types, api client, mock fixtures"
```

---

### Task 8: Frontend — useReview state hook (mutations + debounced autosave)

**Files:**
- Create: `src/review/useReview.ts`
- Create: `src/review/useReview.test.ts`

**Interfaces:**
- Consumes: `Review`, `Comment`, `Anchor`, `CommentScope`, `ViewedEntry` (Task 7); `api.saveReview` (Task 7).
- Produces:
  - `useReview(initial: Review | null)` returning `{ review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed }`.
  - `addComment(scope, anchor, body) -> void` (generates id/timestamps, immediate save); `updateCommentBody(id, body)` (debounced save); `deleteComment(id)` (immediate save); `toggleViewed(file, diffHash)` (immediate save).

- [ ] **Step 1: Write failing tests**

```ts
// src/review/useReview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const saveMock = vi.fn();
vi.mock("../api", () => ({ api: { saveReview: (...a: unknown[]) => saveMock(...a) } }));

import { useReview } from "./useReview";
import type { Review } from "../types";

const base: Review = {
  version: 1, id: "x",
  target: { repoPath: "/r", worktree: "main", mode: "all-changes" },
  snapshot: { baseOid: "b", headOid: null, capturedAt: "t" },
  comments: [], viewed: [], createdAt: "t", lastOpenedAt: "t",
};

describe("useReview", () => {
  beforeEach(() => saveMock.mockReset());

  it("addComment appends and saves immediately", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("general", null, "a note"));
    expect(result.current.review!.comments).toHaveLength(1);
    expect(result.current.review!.comments[0].body).toBe("a note");
    expect(result.current.review!.comments[0].id).toBeTruthy();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it("deleteComment removes and saves", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("general", null, "x"));
    const id = result.current.review!.comments[0].id;
    saveMock.mockReset();
    act(() => result.current.deleteComment(id));
    expect(result.current.review!.comments).toHaveLength(0);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it("toggleViewed adds then removes a viewed entry", () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.toggleViewed("a.ts", "h1"));
    expect(result.current.review!.viewed).toEqual([{ file: "a.ts", diffHash: "h1" }]);
    act(() => result.current.toggleViewed("a.ts", "h1"));
    expect(result.current.review!.viewed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/review/useReview.test.ts`
Expected: FAIL — `./useReview` not found.

- [ ] **Step 3: Implement the hook**

```ts
// src/review/useReview.ts
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Anchor, Comment, CommentScope, Review } from "../types";

const DEBOUNCE_MS = 400;

export function useReview(initial: Review | null) {
  const [review, setReview] = useState<Review | null>(initial);
  const latest = useRef<Review | null>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = review;

  useEffect(() => setReview(initial), [initial]);

  function saveNow() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current) void api.saveReview(latest.current);
  }

  function saveDebounced() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (latest.current) void api.saveReview(latest.current);
    }, DEBOUNCE_MS);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function mutate(fn: (r: Review) => Review, save: "now" | "debounced") {
    setReview((r) => {
      if (!r) return r;
      const next = fn(r);
      latest.current = next;
      return next;
    });
    save === "now" ? saveNow() : saveDebounced();
  }

  function addComment(scope: CommentScope, anchor: Anchor | null, body: string) {
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomUUID(),
      scope,
      anchor: anchor ?? null,
      body,
      stale: false,
      createdAt: now,
      updatedAt: now,
    };
    mutate((r) => ({ ...r, comments: [...r.comments, comment] }), "now");
    return comment.id;
  }

  function updateCommentBody(id: string, body: string) {
    const now = new Date().toISOString();
    mutate(
      (r) => ({ ...r, comments: r.comments.map((c) => (c.id === id ? { ...c, body, updatedAt: now } : c)) }),
      "debounced",
    );
  }

  function deleteComment(id: string) {
    mutate((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== id) }), "now");
  }

  function toggleViewed(file: string, diffHash: string) {
    mutate((r) => {
      const exists = r.viewed.some((v) => v.file === file);
      const viewed = exists ? r.viewed.filter((v) => v.file !== file) : [...r.viewed, { file, diffHash }];
      return { ...r, viewed };
    }, "now");
  }

  return { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/review/useReview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): useReview state hook with debounced autosave"
```

---

### Task 9: Frontend — comment editor + thread components

**Files:**
- Add dep: `react-markdown`
- Create: `src/review/CommentEditor.tsx`
- Create: `src/review/CommentThread.tsx`
- Create: `src/review/CommentThread.test.tsx`

**Interfaces:**
- Consumes: `Comment` (Task 7).
- Produces:
  - `<CommentEditor initialValue?={string} onSubmit={(body: string) => void} onCancel={() => void} autoFocus?={boolean} />` — textarea + Save/Cancel; ⌘↵ submits, Esc cancels.
  - `<CommentThread comments={Comment[]} onEdit={(id, body) => void} onDelete={(id) => void} onReply?={() => void} />` — renders each body via `react-markdown`, a `⚠ stale` badge, and edit/delete affordances.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add react-markdown
```

- [ ] **Step 2: Write a failing CommentThread test**

```tsx
// src/review/CommentThread.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentThread } from "./CommentThread";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "c1", scope: "line", anchor: null, body: "**bold** note", stale: true, createdAt: "t", updatedAt: "t" },
];

describe("CommentThread", () => {
  it("renders markdown body and a stale badge, and fires delete", () => {
    const onDelete = vi.fn();
    render(<CommentThread comments={comments} onEdit={() => {}} onDelete={onDelete} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/review/CommentThread.test.tsx`
Expected: FAIL — `./CommentThread` not found.

- [ ] **Step 4: Implement `CommentEditor`**

```tsx
// src/review/CommentEditor.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CommentEditor({
  initialValue = "",
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initialValue?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const submit = () => {
    const body = value.trim();
    if (body) onSubmit(body);
  };
  return (
    <div className="flex flex-col gap-1.5 p-2">
      <textarea
        autoFocus={autoFocus}
        className="min-h-16 resize-y rounded border bg-background p-2 text-xs font-mono"
        placeholder="Leave a comment (markdown)…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `CommentThread`**

```tsx
// src/review/CommentThread.tsx
import { useState } from "react";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

export function CommentThread({
  comments,
  onEdit,
  onDelete,
}: {
  comments: Comment[];
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="flex flex-col divide-y rounded border bg-muted/30 text-xs">
      {comments.map((c) =>
        editingId === c.id ? (
          <CommentEditor
            key={c.id}
            initialValue={c.body}
            onSubmit={(body) => {
              onEdit(c.id, body);
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={c.id} className="flex flex-col gap-1 p-2">
            {c.stale && <span className="w-fit rounded bg-amber-500/20 px-1 text-[10px] text-amber-600">⚠ stale</span>}
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <Markdown>{c.body}</Markdown>
            </div>
            <div className="flex gap-2 text-muted-foreground">
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={() => setEditingId(c.id)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={() => onDelete(c.id)}>Delete</Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm test src/review/CommentThread.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): comment editor + thread (react-markdown)"
```

---

### Task 10: Frontend — DiffView comment widgets (inside the renderer boundary)

**Files:**
- Modify: `src/diff/DiffView.tsx` (add widget props + extendData/renderExtendLine/renderWidgetLine/onAddWidgetClick)
- Create: `src/diff/commentExtendData.ts`
- Create: `src/diff/commentExtendData.test.ts`

**Interfaces:**
- Consumes: `Comment`, `Anchor`, `Side` (Task 7); `CommentThread`, `CommentEditor` (Task 9); git-diff-view `DiffView`, `SplitSide`, `DiffModeEnum` (0.1.6).
- Produces:
  - `buildExtendData(comments: Comment[]) -> { oldFile?: Record<string,{data: Comment[]}>, newFile?: Record<string,{data: Comment[]}> }` — groups line/range comments by side+startLine for git-diff-view's `extendData`.
  - `<DiffView>` gains props: `comments?: Comment[]`, `onAddComment?: (anchor: Anchor, body: string) => void`, `onEditComment?: (id, body) => void`, `onDeleteComment?: (id) => void`. Renders saved threads via `renderExtendLine` and an inline editor via `renderWidgetLine`, with the gutter add affordance (`diffViewAddWidget`).

Reference (git-diff-view 0.1.6, verified in `index.d.ts`): `enum SplitSide { old = 1, new = 2 }`; `extendData?: { oldFile?: Record<string,{data:T}>; newFile?: Record<string,{data:T}> }`; `renderExtendLine?: ({ diffFile, side, data, lineNumber, onUpdate }) => ReactNode`; `renderWidgetLine?: ({ diffFile, side, lineNumber, onClose }) => ReactNode`; `onAddWidgetClick?: (lineNumber: number, side: SplitSide) => void`; `diffViewAddWidget?: boolean`.

- [ ] **Step 1: Write a failing `buildExtendData` test**

```ts
// src/diff/commentExtendData.test.ts
import { describe, it, expect } from "vitest";
import { buildExtendData } from "./commentExtendData";
import type { Comment } from "../types";

const c = (id: string, side: "new" | "old", startLine: number): Comment => ({
  id, scope: "line",
  anchor: { file: "a.ts", side, startLine, endLine: null, snippet: "x" },
  body: "b", stale: false, createdAt: "t", updatedAt: "t",
});

describe("buildExtendData", () => {
  it("groups comments by side and line number", () => {
    const ext = buildExtendData([c("1", "new", 10), c("2", "new", 10), c("3", "old", 4)]);
    expect(ext.newFile!["10"].data.map((x) => x.id)).toEqual(["1", "2"]);
    expect(ext.oldFile!["4"].data.map((x) => x.id)).toEqual(["3"]);
  });

  it("ignores general comments and anchors without a line", () => {
    const general: Comment = { id: "g", scope: "general", anchor: null, body: "b", stale: false, createdAt: "t", updatedAt: "t" };
    const ext = buildExtendData([general]);
    expect(ext.newFile).toEqual({});
    expect(ext.oldFile).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/diff/commentExtendData.test.ts`
Expected: FAIL — `./commentExtendData` not found.

- [ ] **Step 3: Implement `buildExtendData`**

```ts
// src/diff/commentExtendData.ts
import type { Comment } from "../types";

export interface ExtendData {
  oldFile: Record<string, { data: Comment[] }>;
  newFile: Record<string, { data: Comment[] }>;
}

/** Group line/range comments by side + startLine for git-diff-view's extendData. */
export function buildExtendData(comments: Comment[]): ExtendData {
  const ext: ExtendData = { oldFile: {}, newFile: {} };
  for (const c of comments) {
    const a = c.anchor;
    if (!a || a.startLine == null) continue; // general / file-scope
    const bucket = a.side === "old" ? ext.oldFile : ext.newFile;
    const key = String(a.startLine);
    (bucket[key] ??= { data: [] }).data.push(c);
  }
  return ext;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/diff/commentExtendData.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend `DiffView` with widgets**

```tsx
// src/diff/DiffView.tsx — replace the component with the widget-enabled version
import { DiffView as GitDiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { Anchor, Comment, FileDiff, Side } from "../types";
import { toDiffFile } from "./toDiffFile";
import { buildExtendData } from "./commentExtendData";
import { CommentThread } from "../review/CommentThread";
import { CommentEditor } from "../review/CommentEditor";

const sideToEnum = (s: Side): SplitSide => (s === "old" ? SplitSide.old : SplitSide.new);
const enumToSide = (s: SplitSide): Side => (s === SplitSide.old ? "old" : "new");

export function DiffView({
  fileDiff,
  filePath,
  mode,
  theme = "light",
  comments = [],
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  fileDiff: FileDiff;
  filePath: string;
  mode: "unified" | "split";
  theme?: "light" | "dark";
  comments?: Comment[];
  onAddComment?: (anchor: Anchor, body: string) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  if (fileDiff.binary) {
    return <div className="text-muted-foreground p-6 text-sm">Binary file — not shown</div>;
  }

  const file = toDiffFile(fileDiff); // adapter calls .init()
  file.initTheme(theme);
  mode === "split" ? file.buildSplitDiffLines() : file.buildUnifiedDiffLines();

  const extendData = buildExtendData(comments);

  // Build a line anchor from a clicked widget line, capturing the line's text as snippet.
  const anchorAt = (side: SplitSide, lineNumber: number): Anchor => {
    const s: Side = enumToSide(side);
    const content = s === "old" ? fileDiff.oldContent : fileDiff.newContent;
    const snippet = (content ?? "").split("\n")[lineNumber - 1] ?? "";
    return { file: filePath, side: s, startLine: lineNumber, endLine: null, snippet };
  };

  return (
    <GitDiffView<Comment[]>
      diffFile={file}
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
      diffViewAddWidget
      extendData={extendData}
      renderWidgetLine={({ side, lineNumber, onClose }) => (
        <CommentEditor
          onSubmit={(body) => {
            onAddComment?.(anchorAt(side, lineNumber), body);
            onClose();
          }}
          onCancel={onClose}
        />
      )}
      renderExtendLine={({ data }) => (
        <CommentThread
          comments={data}
          onEdit={(id, body) => onEditComment?.(id, body)}
          onDelete={(id) => onDeleteComment?.(id)}
        />
      )}
    />
  );
}
```

> Note: with `diffViewAddWidget` on, clicking the gutter "+" opens git-diff-view's widget line, which renders `renderWidgetLine` (our `CommentEditor`). The comment is created **only** on editor submit — `onAddComment(anchor, body)` then `onClose()` — so it is added exactly once with its typed body. `onAddWidgetClick` is left unset (notification-only hook). Verify the open/close flow in the harness (Step 7); if the gutter "+" does not open the widget line without it, add `onAddWidgetClick={(lineNumber, side) => {}}` (no-op) — it must not create a comment.

- [ ] **Step 6: Update `DiffView` callers + typecheck**

`DiffView` now requires `filePath`. Update the Plan 1 call site in `Workspace.tsx` (it will be rewritten in Task 13, but keep the build green now): pass `filePath={selected ?? ""}`.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Verify in the browser harness**

```bash
# preview MCP: start the delta-mock server, then drive it.
```
Using the preview MCP (`.claude/launch.json` → `delta-mock`): open the repo, select `src/auth/session.ts`, confirm the seeded comment from the mock fixture renders as a thread under its line (markdown body, edit/delete buttons), click the gutter add affordance on a line, type in the editor, Save, and confirm a single new thread appears (no duplicate). Screenshot. Fix the add-once flow if the screenshot shows a duplicate.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(diff): inline comment widgets in DiffView (extendData/render lines)"
```

---

### Task 11: Frontend — DiffPane all-files scroll + FilesPanel viewed/navigator

**Files:**
- Create: `src/diff/DiffPane.tsx`
- Create: `src/diff/useFileDiffCache.ts`
- Modify: `src/files/FilesPanel.tsx` (viewed checkbox, `N/M viewed`, `onSelect` = scroll-to; de-emphasis)
- Modify: `src/files/FilesPanel.test.tsx` (viewed count assertion)

**Interfaces:**
- Consumes: `FileEntry`, `FileDiff`, `Comment`, `Anchor` (Task 7); `api.getFileDiff` (Plan 1); `DiffView` (Task 10).
- Produces:
  - `useFileDiffCache(target)` returning `{ get(path): FileDiff | undefined, load(path), clear() }` (per-session cache cleared on refresh).
  - `<DiffPane target files={FileEntry[]} comments={Comment[]} viewedFiles={Set<string>} theme onToggleViewed onAddComment onEditComment onDeleteComment scrollToFile?={string} />` — renders a scroll of file sections (header + lazy-mounted `DiffView`), collapses viewed sections to headers, lazy-loads content via IntersectionObserver, exposes scroll-to via section refs.
  - `FilesPanel` gains `viewedFiles: Set<string>`, `onToggleViewed: (file) => void`; header shows `N/M viewed`; selecting a file calls `onSelect(path)` (now "scroll to section").

- [ ] **Step 1: Implement the per-session content cache (with test)**

```ts
// src/diff/useFileDiffCache.ts
import { useRef, useState } from "react";
import { api } from "../api";
import type { FileDiff, Target } from "../types";

export function useFileDiffCache(target: Target | null) {
  const cache = useRef<Map<string, FileDiff>>(new Map());
  const [, force] = useState(0);

  function get(path: string): FileDiff | undefined {
    return cache.current.get(path);
  }
  async function load(path: string) {
    if (!target || cache.current.has(path)) return;
    const fd = await api.getFileDiff(target, path);
    cache.current.set(path, fd);
    force((n) => n + 1);
  }
  function clear() {
    cache.current.clear();
    force((n) => n + 1);
  }
  return { get, load, clear };
}
```

```ts
// src/diff/useFileDiffCache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const getFileDiff = vi.fn();
vi.mock("../api", () => ({ api: { getFileDiff: (...a: unknown[]) => getFileDiff(...a) } }));

import { useFileDiffCache } from "./useFileDiffCache";

const target = { repoPath: "/r", worktree: "main", mode: "all-changes" as const };

describe("useFileDiffCache", () => {
  beforeEach(() => getFileDiff.mockReset());

  it("loads once and caches, clears on demand", async () => {
    getFileDiff.mockResolvedValue({ status: "modified", binary: false });
    const { result } = renderHook(() => useFileDiffCache(target));
    await act(async () => { await result.current.load("a.ts"); });
    expect(result.current.get("a.ts")).toBeTruthy();
    await act(async () => { await result.current.load("a.ts"); }); // cached
    expect(getFileDiff).toHaveBeenCalledTimes(1);
    act(() => result.current.clear());
    expect(result.current.get("a.ts")).toBeUndefined();
  });
});
```

Run: `pnpm test src/diff/useFileDiffCache.test.ts`
Expected: FAIL → implement above → PASS.

- [ ] **Step 2: Implement `DiffPane`**

```tsx
// src/diff/DiffPane.tsx
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DiffView } from "./DiffView";
import { useFileDiffCache } from "./useFileDiffCache";
import type { Anchor, Comment, FileEntry, Target } from "../types";

function commentsForFile(comments: Comment[], file: string): Comment[] {
  return comments.filter((c) => c.anchor?.file === file);
}

function FileSection({
  entry, target, cache, comments, viewed, theme, onToggleViewed, onAddComment, onEditComment, onDeleteComment, registerRef,
}: {
  entry: FileEntry; target: Target; cache: ReturnType<typeof useFileDiffCache>;
  comments: Comment[]; viewed: boolean; theme: "light" | "dark";
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor) => void; onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
  registerRef: (file: string, el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fd = cache.get(entry.path);

  useEffect(() => {
    registerRef(entry.path, ref.current);
    return () => registerRef(entry.path, null);
  }, [entry.path]);

  useEffect(() => {
    if (viewed || fd || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void cache.load(entry.path);
        io.disconnect();
      }
    }, { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [entry.path, viewed, fd]);

  return (
    <div ref={ref} data-file={entry.path} className="border-b">
      <div className={`flex items-center gap-2 px-3 py-1.5 text-xs sticky top-0 bg-background border-b ${viewed ? "opacity-50" : ""}`}>
        <button className="flex items-center gap-1" onClick={() => onToggleViewed(entry.path)} aria-label="toggle viewed">
          {viewed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <input type="checkbox" checked={viewed} onChange={() => onToggleViewed(entry.path)} aria-label={`viewed ${entry.path}`} />
        </button>
        <span className="font-mono">{entry.path}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {entry.additions > 0 && <span className="text-emerald-600">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-red-600">−{entry.deletions}</span>}
        </span>
      </div>
      {!viewed && (
        <div className="min-h-8">
          {fd ? (
            <DiffView
              fileDiff={fd}
              filePath={entry.path}
              mode="unified"
              theme={theme}
              comments={commentsForFile(comments, entry.path)}
              onAddComment={onAddComment}
              onEditComment={onEditComment}
              onDeleteComment={onDeleteComment}
            />
          ) : (
            <div className="p-4 text-xs text-muted-foreground">Loading…</div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffPane({
  target, files, comments, viewedFiles, theme, scrollToFile,
  onToggleViewed, onAddComment, onEditComment, onDeleteComment,
}: {
  target: Target; files: FileEntry[]; comments: Comment[]; viewedFiles: Set<string>;
  theme: "light" | "dark"; scrollToFile?: string | null;
  onToggleViewed: (file: string) => void;
  onAddComment: (a: Anchor) => void; onEditComment: (id: string, body: string) => void; onDeleteComment: (id: string) => void;
}) {
  const cache = useFileDiffCache(target);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerRef = (file: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(file, el);
    else sectionRefs.current.delete(file);
  };

  useEffect(() => {
    if (scrollToFile) sectionRefs.current.get(scrollToFile)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollToFile]);

  return (
    <div className="h-full overflow-auto" data-testid="diff-pane">
      {files.map((entry) => (
        <FileSection
          key={entry.path}
          entry={entry}
          target={target}
          cache={cache}
          comments={comments}
          viewed={viewedFiles.has(entry.path)}
          theme={theme}
          onToggleViewed={onToggleViewed}
          onAddComment={onAddComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Update `FilesPanel` for viewed + navigator**

Add `viewedFiles: Set<string>` and `onToggleViewed: (file) => void` props. In the header, render `{viewedFiles.size}/{files.length} viewed`. In `FileNode`, when the node is a file, show a checkbox bound to `viewedFiles.has(path)` calling `onToggleViewed(path)`, and apply `opacity-50` to viewed rows. Keep `onSelect(path)` (now "scroll to section"). Wire `viewedFiles`/`onToggleViewed` through the `Tree`'s render props (react-arborist passes the row's data; read viewed state from a closure over the prop).

```tsx
// FilesPanel.tsx — header count (replace the `viewed = 0` placeholder)
<span className="ml-auto">{viewedFiles.size}/{files.length} viewed</span>
```

```tsx
// FilesPanel.test.tsx — update the count assertion
it("shows the viewed count in the header", () => {
  render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} />);
  expect(screen.getByText(/1\/1 viewed/)).toBeInTheDocument();
});
```

- [ ] **Step 4: Run logic tests + typecheck**

Run: `pnpm test src/diff/useFileDiffCache.test.ts src/files/FilesPanel.test.tsx && pnpm exec tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Verify in the browser harness**

Drive `delta-mock`: confirm the diff pane shows **all files stacked** with sticky headers; scrolling lazy-loads lower sections; checking a file's viewed box collapses its section to the header and dims the row and bumps the `N/M viewed` count; clicking a file in the panel scrolls to its section. Screenshot before/after a viewed toggle.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(diff): all-files scroll DiffPane + FilesPanel viewed/navigator"
```

---

### Task 12: Frontend — comment index overlay (⌘2) + General note + jump

**Files:**
- Add via shadcn: `src/components/ui/dialog.tsx`
- Create: `src/review/CommentIndex.tsx`
- Create: `src/review/CommentIndex.test.tsx`

**Interfaces:**
- Consumes: `Comment`, `Review` (Task 7); `CommentEditor` (Task 9); shadcn `Dialog`.
- Produces:
  - `<CommentIndex open onOpenChange comments={Comment[]} onJump={(comment) => void} onAddGeneral={(body) => void} />` — overlay listing General comments first, then grouped by file/startLine; each row shows location + body preview + `⚠ stale`; clicking a row calls `onJump`; a "General note" affordance opens `CommentEditor` and calls `onAddGeneral`.

- [ ] **Step 1: Add the shadcn dialog**

```bash
pnpm dlx shadcn@latest add dialog
```

- [ ] **Step 2: Write a failing test**

```tsx
// src/review/CommentIndex.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentIndex } from "./CommentIndex";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "g", scope: "general", anchor: null, body: "overall note", stale: false, createdAt: "t", updatedAt: "t" },
  { id: "l", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 22, endLine: null, snippet: "x" }, body: "line note", stale: true, createdAt: "t", updatedAt: "t" },
];

describe("CommentIndex", () => {
  it("lists comments and jumps on click", () => {
    const onJump = vi.fn();
    render(<CommentIndex open onOpenChange={() => {}} comments={comments} onJump={onJump} onAddGeneral={() => {}} />);
    expect(screen.getByText("overall note")).toBeInTheDocument();
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/L22/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("line note"));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "l" }));
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/review/CommentIndex.test.tsx`
Expected: FAIL — `./CommentIndex` not found.

- [ ] **Step 4: Implement `CommentIndex`**

```tsx
// src/review/CommentIndex.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

function locationLabel(c: Comment): string {
  if (c.scope === "general") return "General";
  const a = c.anchor;
  if (!a) return "General";
  if (a.startLine == null) return `${a.file} · file`;
  const range = a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return `${a.file} · ${range}`;
}

export function CommentIndex({
  open, onOpenChange, comments, onJump, onAddGeneral,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
  onAddGeneral: (body: string) => void;
}) {
  const [addingGeneral, setAddingGeneral] = useState(false);
  const generals = comments.filter((c) => c.scope === "general");
  const anchored = comments
    .filter((c) => c.scope !== "general")
    .sort((a, b) => {
      const fa = a.anchor?.file ?? "", fb = b.anchor?.file ?? "";
      return fa === fb ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0) : fa.localeCompare(fb);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[70vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Comments ({comments.length})</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          <div>
            {addingGeneral ? (
              <CommentEditor
                onSubmit={(body) => { onAddGeneral(body); setAddingGeneral(false); }}
                onCancel={() => setAddingGeneral(false)}
              />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAddingGeneral(true)}>+ General note</Button>
            )}
          </div>
          {[...generals, ...anchored].map((c) => (
            <button key={c.id} className="flex flex-col items-start gap-0.5 rounded border p-2 text-left hover:bg-muted" onClick={() => onJump(c)}>
              <span className="text-[11px] text-muted-foreground">
                {locationLabel(c)}{c.stale ? " · ⚠ stale" : ""}
              </span>
              <span className="line-clamp-2">{c.body}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test src/review/CommentIndex.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ui): comment index overlay with General note + jump"
```

---

### Task 13: Frontend — Workspace wiring (open_review bootstrap, Refresh, Copy for Claude, keyboard)

**Files:**
- Modify: `src/workspace/Workspace.tsx`
- Modify: `src/workspace/Workspace.test.tsx`

**Interfaces:**
- Consumes: `api.openReview`/`refreshReview`/`exportReview` (Task 7); `useReview` (Task 8); `DiffPane` (Task 11); `CommentIndex` (Task 12); `FilesPanel` (Task 11); `useSystemTheme` (Plan 1).
- Produces: a workspace that opens a review (load-or-create), renders the all-files scroll with comments + viewed, refreshes (reconcile), copies the export to the clipboard, and handles the keyboard subset.

- [ ] **Step 1: Rewrite `Workspace` to drive the review**

```tsx
// src/workspace/Workspace.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffPane } from "../diff/DiffPane";
import { CommentIndex } from "../review/CommentIndex";
import { useReview } from "../review/useReview";
import { useSystemTheme } from "../theme";
import type { Anchor, Comment, DiffMode, DiffSummary, Review } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

export function Workspace() {
  const theme = useSystemTheme();
  const [repoPath, setRepoPath] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("all-changes");
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);

  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed } = useReview(null);

  async function open(repo: string, m: DiffMode) {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: repo, mode: m });
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (opened) void open(opened, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, mode]);

  async function refresh() {
    if (!review) return;
    try {
      const session = await api.refreshReview(review);
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyForClaude() {
    if (!review) return;
    const md = await api.exportReview(review);
    await navigator.clipboard.writeText(md);
  }

  function jumpTo(c: Comment) {
    setIndexOpen(false);
    if (c.anchor?.file) setScrollToFile(c.anchor.file + "#" + Date.now()); // force effect re-run
  }

  const viewedFiles = new Set((review?.viewed ?? []).map((v) => v.file));
  const comments = review?.comments ?? [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "2" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setIndexOpen((o) => !o); }
      else if (e.key === "r" && !e.metaKey && !e.ctrlKey && document.activeElement?.tagName !== "TEXTAREA") { void refresh(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  return (
    <div data-testid="app-root" className="flex flex-col h-screen text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <input className="border rounded px-2 py-1 text-xs bg-background" placeholder="Repo path" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <Button size="sm" variant="secondary" onClick={() => setOpened(repoPath.trim() || null)}>Open</Button>
        {opened && summary && (
          <>
            <span className="text-xs text-muted-foreground">{summary.baseLabel} → {summary.headLabel}</span>
            <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as DiffMode)} className="ml-2">
              {MODES.map((m) => <ToggleGroupItem key={m.id} value={m.id}>{m.label}</ToggleGroupItem>)}
            </ToggleGroup>
            <Button size="sm" variant="ghost" onClick={() => setIndexOpen(true)}>Comments ({comments.length})</Button>
            <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
            <Button size="sm" onClick={copyForClaude} className="ml-auto">Copy for Claude</Button>
          </>
        )}
      </div>
      {error && <div className="px-3 py-1 text-red-600 text-xs">{error}</div>}
      <div className="flex flex-1 min-h-0">
        {summary && review && (
          <>
            <div className="w-80 border-r min-h-0 flex flex-col">
              <FilesPanel
                files={summary.files}
                selected={null}
                onSelect={(p) => setScrollToFile(p + "#" + Date.now())}
                viewedFiles={viewedFiles}
                onToggleViewed={(file) => {
                  // diffHash is computed by reconcile; toggling stores the file's current hash if known, else "".
                  toggleViewed(file, "");
                }}
              />
            </div>
            <div className="flex-1 min-h-0">
              <DiffPane
                target={review.target}
                files={summary.files}
                comments={comments}
                viewedFiles={viewedFiles}
                theme={theme}
                scrollToFile={scrollToFile?.split("#")[0] ?? null}
                onToggleViewed={(file) => toggleViewed(file, "")}
                onAddComment={(anchor: Anchor, body: string) => addComment(anchor.startLine == null ? "file" : "line", anchor, body)}
                onEditComment={updateCommentBody}
                onDeleteComment={deleteComment}
              />
            </div>
          </>
        )}
        {(!summary || !review) && <div className="p-6 text-muted-foreground">Open a repo to start a review</div>}
      </div>
      <CommentIndex
        open={indexOpen}
        onOpenChange={setIndexOpen}
        comments={comments}
        onJump={jumpTo}
        onAddGeneral={(body) => addComment("general", null, body)}
      />
    </div>
  );
}
```

> Note: `onAddComment(anchor, body)` is created once by Task 10's `renderWidgetLine` editor on submit; here it maps to `addComment(scope, anchor, body)` (scope `file` when the anchor has no line, else `line`). Range comments (multi-line selection) are out of the initial affordance set and can be added later via the same path with `endLine` set.

- [ ] **Step 2: Update the Workspace test**

```tsx
// src/workspace/Workspace.test.tsx — mock api.openReview and assert bootstrap renders
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const openReview = vi.fn();
vi.mock("../api", () => ({ api: { openReview: (...a: unknown[]) => openReview(...a), refreshReview: vi.fn(), saveReview: vi.fn(), exportReview: vi.fn(), getFileDiff: vi.fn() } }));

import { Workspace } from "./Workspace";

describe("Workspace", () => {
  beforeEach(() => openReview.mockReset());

  it("opens a review and shows the toolbar", async () => {
    openReview.mockResolvedValue({
      review: { id: "x", target: { repoPath: "/r", worktree: "main", mode: "all-changes" }, comments: [], viewed: [], snapshot: { baseOid: "b", capturedAt: "t" }, createdAt: "t", lastOpenedAt: "t", version: 1 },
      summary: { files: [], baseLabel: "main", headLabel: "wt" },
    });
    render(<Workspace />);
    fireEvent.change(screen.getByPlaceholderText("Repo path"), { target: { value: "/r" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for claude/i })).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all pass; tsc exit 0.

- [ ] **Step 4: Full browser-harness walkthrough**

Drive `delta-mock` end-to-end: open repo → all-files scroll renders with the seeded comments → add a line comment via the gutter → edit it → mark a file viewed (collapses) → open the comment index (⌘2), add a General note, click a row to jump/scroll → click **Copy for Claude** and read it back via `preview_eval(navigator.clipboard.readText())` to confirm the markdown. Screenshot the key states. Fix any issue before the human sign-off.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(workspace): review bootstrap, refresh, comment index, Copy for Claude, keyboard"
```

---

## Self-Review

**Spec coverage** (spec §-by-§ → task):
- §2 data model → Tasks 1 (model), 7 (TS mirror). §5 IDs/worktree → Task 1.
- §6 persistence/autosave → Tasks 2 (atomic storage), 8 (debounced mutations).
- §7 anchoring/freeze → Tasks 3 (exact/fuzzy/stale + diffHash), 4 (reconcile), 11 (per-session cache).
- §8 all-files scroll → Task 11. §9 comment UI (widgets/editor/index) → Tasks 9, 10, 12.
- §10 viewed → Tasks 11 (UI), 4 (reset). §11 export → Tasks 5 (serializer), 13 (button/clipboard).
- §12 workspace/keyboard → Task 13. §13 command surface → Task 6. §14 testing → Rust tests + browser-harness steps in Tasks 10/11/13.

**Cross-task seam (Task 10 ↔ 13):** the line-comment add flow uses a single `onAddComment(anchor, body)` signature — Task 10's `renderWidgetLine` editor creates the comment once on submit; Task 13 maps it to `addComment(scope, anchor, body)`. The reviewer should confirm this seam holds and that the harness shows exactly one comment per add.

**`viewed` diffHash:** the UI toggles `viewed` with `diffHash: ""` (the file's hash isn't on the client until reconcile). The next `open_review`/`refresh_review` recomputes hashes; a viewed entry with a stale/empty hash is dropped if it doesn't match. If "viewed survives refresh when unchanged" must hold immediately, expose each file's `diffHash` in `DiffSummary.files` (extend `FileEntry` in a follow-up) and pass it to `toggleViewed`. Noted as a deliberate, low-risk simplification for Plan 2.

**Placeholder scan:** no TBD/TODO; every code step is complete. **Type consistency:** `ReviewSession {review, summary}`, `Anchor {file, side, startLine?, endLine?, snippet?}`, `Side`/`CommentScope` lowercase, `DiffMode` kebab — consistent across Rust (Task 1/4/6) and TS (Task 7) and the git-diff-view `extendData`/`SplitSide` usage (Task 10).

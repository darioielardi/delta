# delta — Plan 1: Foundations & Diff Viewing (read-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tauri 2 + React/TS shell and a Rust git engine so you can open a repo, pick a diff mode, and view the rendered diff (files panel + git-diff-view) — read-only, no comments yet.

**Architecture:** Rust (git2) owns repo access, target/ref resolution, the changed-file set, status, rename detection, and per-file old/new **content**. The React frontend calls two Tauri commands (`compute_diff`, `get_file_diff`) and renders with `@git-diff-view/react`, which computes the intra-file line diff from content via `generateDiffFile`. Diff content is fetched lazily per file (only when selected) to keep large diffs fast.

**Tech Stack:** Tauri 2, Rust + git2, React 18 + TypeScript + Vite, `@git-diff-view/react` + `@git-diff-view/file`, vitest + @testing-library/react (frontend tests), tempfile + git2 (Rust tests).

## Global Constraints

- **Startup target:** <1s; keep dependencies lean, lazy-load diff content per file.
- **Renderer is isolated:** all `@git-diff-view/*` usage lives behind a single `DiffView` React component. No other file imports git-diff-view.
- **Renderer version pinned:** install `@git-diff-view/react` and `@git-diff-view/file` at an exact version (no `^`).
- **Diff modes (preset ids, serialized kebab-case):** `all-changes` (default), `uncommitted`, `last-commit`, `branch-vs-base`.
- **`all-changes` = `merge-base(base) → working tree`** (the hero/default mode). Base = auto-detected default branch (`origin/HEAD` → `main` → `master`), overridable.
- **Empty diff → "Nothing to review" empty state.** No automatic mode fallback.
- **Nothing is ever written into the user's repo / working tree.**
- **Rust↔TS payloads are camelCase** (`#[serde(rename_all = "camelCase")]`); enum values kebab-case/lowercase as specified per type.
- **Package manager is pnpm.** Use `pnpm` for everything: `pnpm install`, `pnpm <script>`, `pnpm tauri dev`. Add deps with `pnpm add` (`-D` dev, `-E` exact). Scaffold with `--manager pnpm`. (pnpm only affects the JS frontend; the Rust/cargo build is unaffected.)

**Deviation from spec §7 (flagged):** Rust does not emit git hunk strings in this plan; git-diff-view computes the line diff from old/new content. Rust remains the source of truth for *which* files changed, their status, renames, and content. Revisit if exact git-algorithm parity is ever required.

---

### Task 1: Project scaffold (Tauri 2 + React-TS + Vite)

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable Tauri app; the Rust crate exposes `pub fn run()` (called by `main.rs`); the `tauri::Builder` in `lib.rs` is where Task 5 registers commands.

- [ ] **Step 1: Scaffold via the official CLI into a temp dir, then merge into the repo root**

The repo root already contains `.git`, `.gitignore`, and `docs/`, so scaffold elsewhere and copy in (avoids the non-empty-dir refusal).

```bash
cd /tmp && rm -rf delta-scaffold
pnpm dlx create-tauri-app delta-scaffold --template react-ts --manager pnpm
# In the scaffold prompts/flags: app name "delta", React, TypeScript, pnpm.
cd /Users/dario.ielardi/projects/delta
rsync -a --exclude='.git' --exclude='node_modules' /tmp/delta-scaffold/ ./
rm -rf /tmp/delta-scaffold
```

- [ ] **Step 2: Pin the renderer dependencies and install**

```bash
pnpm install
pnpm add -E @git-diff-view/react@0.1.5 @git-diff-view/file@0.1.5
```

(If 0.1.5 is unavailable, install the current latest with `--save-exact` and record the pinned version in this step.)

- [ ] **Step 3: Verify the app boots**

```bash
pnpm tauri dev
```
Expected: a native window opens showing the default Tauri+React template. Close it (Ctrl-C) to continue.

- [ ] **Step 4: Replace `src/App.tsx` with a minimal placeholder**

```tsx
// src/App.tsx
export default function App() {
  return <div data-testid="app-root">delta</div>;
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + React-TS app and pin git-diff-view"
```

---

### Task 2: Rust git engine — repo open, target & ref resolution

**Files:**
- Create: `src-tauri/src/git/mod.rs`
- Create: `src-tauri/src/git/model.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod git;`)
- Modify: `src-tauri/Cargo.toml` (add deps)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum DiffMode { AllChanges, Uncommitted, LastCommit, BranchVsBase }` (serde kebab-case)
  - `struct Target { repo_path: String, mode: DiffMode, base: Option<String> }`
  - `fn open_repo(repo_path: &str) -> Result<git2::Repository, GitError>`
  - `fn resolve_endpoints(repo: &Repository, target: &Target) -> Result<Endpoints, GitError>` where `struct Endpoints { from_tree: Option<git2::Oid>, right: RightSide, base_label: String, head_label: String }` and `enum RightSide { Tree(git2::Oid), WorkTree }`
  - `type GitError = String` (commands return `Result<_, String>`)

- [ ] **Step 1: Add dependencies**

```toml
# src-tauri/Cargo.toml — under [dependencies]
git2 = "0.19"
serde = { version = "1", features = ["derive"] }

# under [dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the model + a failing test for mode serialization and base resolution**

```rust
// src-tauri/src/git/model.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffMode {
    AllChanges,
    Uncommitted,
    LastCommit,
    BranchVsBase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub repo_path: String,
    pub mode: DiffMode,
    pub base: Option<String>,
}
```

```rust
// src-tauri/src/git/mod.rs
pub mod model;

use git2::{Oid, Repository, Tree};
use model::{DiffMode, Target};

pub type GitError = String;

pub enum RightSide {
    Tree(Oid),
    WorkTree,
}

pub struct Endpoints {
    pub from_tree: Option<Oid>,
    pub right: RightSide,
    pub base_label: String,
    pub head_label: String,
}

pub fn open_repo(repo_path: &str) -> Result<Repository, GitError> {
    Repository::discover(repo_path).map_err(|e| format!("open repo: {e}"))
}

fn tree_of<'r>(repo: &'r Repository, oid: Oid) -> Result<Tree<'r>, GitError> {
    repo.find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| format!("tree: {e}"))
}

/// Resolve the base branch to (label, commit oid). Tries origin/HEAD, then main, then master.
pub fn resolve_base(repo: &Repository, base: Option<&str>) -> Result<(String, Oid), GitError> {
    let candidates: Vec<String> = match base {
        Some(b) => vec![b.to_string()],
        None => vec!["origin/HEAD".into(), "main".into(), "master".into()],
    };
    for name in candidates {
        if let Ok(obj) = repo.revparse_single(&name) {
            if let Ok(commit) = obj.peel_to_commit() {
                let label = name.trim_start_matches("origin/").to_string();
                return Ok((label, commit.id()));
            }
        }
    }
    Err("could not resolve a base branch (tried origin/HEAD, main, master)".into())
}

pub fn resolve_endpoints(repo: &Repository, target: &Target) -> Result<Endpoints, GitError> {
    let head_ref = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_commit = head_ref.peel_to_commit().map_err(|e| format!("head commit: {e}"))?;
    let head_label = head_ref
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|| short_oid(head_commit.id()));

    match target.mode {
        DiffMode::Uncommitted => Ok(Endpoints {
            from_tree: Some(head_commit.tree().unwrap().id()),
            right: RightSide::WorkTree,
            base_label: head_label.clone(),
            head_label: "working tree".into(),
        }),
        DiffMode::LastCommit => {
            let parent = head_commit
                .parent(0)
                .map_err(|_| "last-commit: HEAD has no parent".to_string())?;
            Ok(Endpoints {
                from_tree: Some(parent.tree().unwrap().id()),
                right: RightSide::Tree(head_commit.tree().unwrap().id()),
                base_label: short_oid(parent.id()),
                head_label: short_oid(head_commit.id()),
            })
        }
        DiffMode::AllChanges | DiffMode::BranchVsBase => {
            let (base_label, base_oid) = resolve_base(repo, target.base.as_deref())?;
            let mb = repo
                .merge_base(head_commit.id(), base_oid)
                .map_err(|e| format!("merge-base: {e}"))?;
            let from_tree = Some(tree_of(repo, mb)?.id());
            let right = match target.mode {
                DiffMode::AllChanges => RightSide::WorkTree,
                _ => RightSide::Tree(head_commit.tree().unwrap().id()),
            };
            Ok(Endpoints { from_tree, right, base_label, head_label })
        }
    }
}

fn short_oid(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// A repo with one commit on `main` adding `file.txt` = "line1\nline2\n".
    pub fn repo_with_commit() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // ensure branch is named main
        repo.set_head("refs/heads/main").ok();
        write(dir.path(), "file.txt", "line1\nline2\n");
        commit_all(&repo, "initial");
        (dir, repo)
    }

    pub fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    pub fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::test_support::*;

    #[test]
    fn mode_serializes_kebab_case() {
        let json = serde_json::to_string(&DiffMode::AllChanges).unwrap();
        assert_eq!(json, "\"all-changes\"");
    }

    #[test]
    fn resolve_base_finds_main() {
        let (_dir, repo) = repo_with_commit();
        let (label, _oid) = resolve_base(&repo, None).unwrap();
        assert_eq!(label, "main");
    }
}
```

Add to `src-tauri/src/lib.rs` (near the top, before `run`):

```rust
mod git;
```

Add `serde_json` to dev-deps for the test:

```toml
# src-tauri/Cargo.toml — under [dev-dependencies]
serde_json = "1"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test git::tests`
Expected: compile error or FAIL until the module compiles and `resolve_base` works.

- [ ] **Step 4: Make them pass**

The code in Step 2 is the implementation. Fix any compile errors until:
Run: `cd src-tauri && cargo test git::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(git): repo open + target/ref resolution for the four modes"
```

---

### Task 3: Rust git engine — changed-file list

**Files:**
- Create: `src-tauri/src/git/diff.rs`
- Modify: `src-tauri/src/git/mod.rs` (add `pub mod diff;`, export types)

**Interfaces:**
- Consumes: `open_repo`, `resolve_endpoints`, `Endpoints`, `RightSide` (Task 2).
- Produces:
  - `enum FileStatus { Added, Modified, Deleted, Renamed }` (serde lowercase)
  - `struct FileEntry { path: String, old_path: Option<String>, status: FileStatus, additions: usize, deletions: usize, binary: bool }` (camelCase)
  - `struct DiffSummary { files: Vec<FileEntry>, base_label: String, head_label: String }` (camelCase)
  - `fn compute_diff(target: &Target) -> Result<DiffSummary, GitError>`
  - `fn build_diff<'r>(repo: &'r Repository, ep: &Endpoints) -> Result<git2::Diff<'r>, GitError>` (also used by Task 4)

- [ ] **Step 1: Write failing tests**

```rust
// src-tauri/src/git/diff.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), mode, base: None }
    }

    #[test]
    fn uncommitted_lists_modified_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let summary = compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");
        assert_eq!(summary.files[0].status, FileStatus::Modified);
    }

    #[test]
    fn uncommitted_lists_untracked_new_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "new.txt", "hello\n");
        let summary = compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let new_file = summary.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new_file.status, FileStatus::Added);
    }

    #[test]
    fn clean_tree_all_changes_is_empty() {
        let (dir, _repo) = repo_with_commit();
        let summary = compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::AllChanges)).unwrap();
        assert_eq!(summary.files.len(), 0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test git::diff`
Expected: FAIL — `compute_diff` not defined.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/git/diff.rs  (above the #[cfg(test)] mod)
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, Endpoints, GitError, RightSide};
use git2::{Diff, DiffFindOptions, DiffOptions, Repository};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<FileEntry>,
    pub base_label: String,
    pub head_label: String,
}

pub fn build_diff<'r>(repo: &'r Repository, ep: &Endpoints) -> Result<Diff<'r>, GitError> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let from_tree = match ep.from_tree {
        Some(oid) => Some(repo.find_commit(oid).map(|c| c.tree()).map_err(|e| e.to_string())?.map_err(|e| e.to_string())?),
        None => None,
    };
    let mut diff = match &ep.right {
        RightSide::WorkTree => repo
            .diff_tree_to_workdir_with_index(from_tree.as_ref(), Some(&mut opts))
            .map_err(|e| format!("diff workdir: {e}"))?,
        RightSide::Tree(oid) => {
            let to = repo.find_commit(*oid).and_then(|c| c.tree()).map_err(|e| e.to_string())?;
            repo.diff_tree_to_tree(from_tree.as_ref(), Some(&to), Some(&mut opts))
                .map_err(|e| format!("diff trees: {e}"))?
        }
    };
    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find)).map_err(|e| format!("find renames: {e}"))?;
    Ok(diff)
}

fn map_status(s: git2::Delta) -> FileStatus {
    match s {
        git2::Delta::Added | git2::Delta::Untracked | git2::Delta::Copied => FileStatus::Added,
        git2::Delta::Deleted => FileStatus::Deleted,
        git2::Delta::Renamed => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

pub fn compute_diff(target: &Target) -> Result<DiffSummary, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let mut files = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let new_path = delta.new_file().path().map(|p| p.to_string_lossy().to_string());
        let old_path = delta.old_file().path().map(|p| p.to_string_lossy().to_string());
        let path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();
        let (additions, deletions) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(p)) => {
                let (_ctx, add, del) = p.line_stats().unwrap_or((0, 0, 0));
                (add, del)
            }
            _ => (0, 0),
        };
        files.push(FileEntry {
            path,
            old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
            status: map_status(delta.status()),
            additions,
            deletions,
            binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
        });
    }

    Ok(DiffSummary { files, base_label: ep.base_label, head_label: ep.head_label })
}
```

Add to `src-tauri/src/git/mod.rs`:

```rust
pub mod diff;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test git::diff`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(git): compute changed-file list with status, stats, renames"
```

---

### Task 4: Rust git engine — per-file content + language

**Files:**
- Modify: `src-tauri/src/git/diff.rs` (add `FileDiff`, `get_file_diff`)
- Create: `src-tauri/src/git/lang.rs`
- Modify: `src-tauri/src/git/mod.rs` (add `pub mod lang;`)

**Interfaces:**
- Consumes: `open_repo`, `resolve_endpoints`, `build_diff`, `Endpoints`, `RightSide`, `FileStatus` (Tasks 2–3).
- Produces:
  - `struct FileDiff { old_file_name: Option<String>, old_content: Option<String>, old_lang: Option<String>, new_file_name: Option<String>, new_content: Option<String>, new_lang: Option<String>, status: FileStatus, binary: bool }` (camelCase)
  - `fn get_file_diff(target: &Target, path: &str) -> Result<FileDiff, GitError>`
  - `fn lang_for(path: &str) -> Option<String>`

- [ ] **Step 1: Write failing tests**

```rust
// add to the #[cfg(test)] mod tests in src-tauri/src/git/diff.rs
#[test]
fn file_diff_returns_old_and_new_content() {
    let (dir, _repo) = repo_with_commit();
    write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
    let fd = get_file_diff(
        &Target { repo_path: dir.path().to_str().unwrap().into(), mode: DiffMode::Uncommitted, base: None },
        "file.txt",
    ).unwrap();
    assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
    assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
    assert_eq!(fd.new_lang.as_deref(), None); // .txt → no lang
}

#[test]
fn lang_for_maps_typescript() {
    assert_eq!(super::lang_for("src/a.ts").as_deref(), Some("typescript"));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test git::diff`
Expected: FAIL — `get_file_diff` / `lang_for` not defined.

- [ ] **Step 3: Implement the language map**

```rust
// src-tauri/src/git/lang.rs
pub fn lang_for(path: &str) -> Option<String> {
    let ext = path.rsplit('.').next()?;
    let lang = match ext {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "rb" => "ruby",
        "json" => "json",
        "css" => "css",
        "html" => "html",
        "md" => "markdown",
        "sh" | "bash" => "bash",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        _ => return None,
    };
    Some(lang.to_string())
}
```

- [ ] **Step 4: Implement `get_file_diff`**

```rust
// add to src-tauri/src/git/diff.rs (above the test module)
use crate::git::lang::lang_for;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_file_name: Option<String>,
    pub old_content: Option<String>,
    pub old_lang: Option<String>,
    pub new_file_name: Option<String>,
    pub new_content: Option<String>,
    pub new_lang: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
}

pub fn get_file_diff(target: &Target, path: &str) -> Result<FileDiff, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    // Locate the delta for this path (match new path, else old path).
    let delta = diff.deltas().find(|d| {
        d.new_file().path().map(|p| p.to_string_lossy() == path).unwrap_or(false)
            || d.old_file().path().map(|p| p.to_string_lossy() == path).unwrap_or(false)
    }).ok_or_else(|| format!("file not in diff: {path}"))?;

    let binary = delta.new_file().is_binary() || delta.old_file().is_binary();
    let status = map_status(delta.status());

    let old_path = delta.old_file().path().map(|p| p.to_string_lossy().to_string());
    let new_path = delta.new_file().path().map(|p| p.to_string_lossy().to_string());

    // Old content: read the old blob from the `from_tree`.
    let old_content = if binary { None } else {
        match (ep.from_tree, &old_path) {
            (Some(tree_oid), Some(op)) => {
                let tree = repo.find_commit(tree_oid).and_then(|c| c.tree()).map_err(|e| e.to_string())?;
                match tree.get_path(std::path::Path::new(op)) {
                    Ok(entry) => {
                        let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
                        Some(String::from_utf8_lossy(blob.content()).to_string())
                    }
                    Err(_) => None, // added file: not in old tree
                }
            }
            _ => None,
        }
    };

    // New content: from the working tree (worktree modes) or the new blob (tree modes).
    let new_content = if binary { None } else {
        match (&ep.right, &new_path) {
            (RightSide::WorkTree, Some(np)) => {
                let wd = repo.workdir().ok_or("no working directory")?;
                fs::read_to_string(wd.join(np)).ok()
            }
            (RightSide::Tree(_), Some(np)) => {
                // re-find the delta's new blob id
                let blob = repo.find_blob(delta.new_file().id()).ok();
                blob.map(|b| String::from_utf8_lossy(b.content()).to_string())
                    .or_else(|| Some(String::new()))
                    .filter(|_| np.is_empty() == false)
            }
            _ => None,
        }
    };

    Ok(FileDiff {
        old_lang: old_path.as_deref().and_then(lang_for),
        new_lang: new_path.as_deref().and_then(lang_for),
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        status,
        binary,
    })
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd src-tauri && cargo test git::diff`
Expected: PASS (5 tests total).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(git): per-file old/new content + language detection"
```

---

### Task 5: Tauri commands exposing the engine

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: `compute_diff`, `get_file_diff`, `Target`, `DiffSummary`, `FileDiff` (Tasks 2–4).
- Produces (the invoke API):
  - command `compute_diff(target: Target) -> Result<DiffSummary, String>`
  - command `get_file_diff(target: Target, path: String) -> Result<FileDiff, String>`

- [ ] **Step 1: Write a failing test (Rust) that the commands delegate correctly**

```rust
// src-tauri/src/commands.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    #[test]
    fn compute_diff_command_returns_summary() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "a\nb\n");
        let summary = compute_diff_impl(Target {
            repo_path: dir.path().to_str().unwrap().into(),
            mode: DiffMode::Uncommitted,
            base: None,
        }).unwrap();
        assert_eq!(summary.files.len(), 1);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `compute_diff_impl` not defined.

- [ ] **Step 3: Implement the commands (thin wrappers; `_impl` fns keep them testable)**

```rust
// src-tauri/src/commands.rs  (above the test module)
use crate::git::diff::{compute_diff as engine_compute, get_file_diff as engine_file, DiffSummary, FileDiff};
use crate::git::model::Target;

pub fn compute_diff_impl(target: Target) -> Result<DiffSummary, String> {
    engine_compute(&target)
}

pub fn get_file_diff_impl(target: Target, path: String) -> Result<FileDiff, String> {
    engine_file(&target, &path)
}

#[tauri::command]
pub fn compute_diff(target: Target) -> Result<DiffSummary, String> {
    compute_diff_impl(target)
}

#[tauri::command]
pub fn get_file_diff(target: Target, path: String) -> Result<FileDiff, String> {
    get_file_diff_impl(target, path)
}
```

Wire into `src-tauri/src/lib.rs`:

```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(Keep the existing `mod git;` line. Remove the template's sample `greet` command if present.)

- [ ] **Step 4: Run to verify pass + app still builds**

Run: `cd src-tauri && cargo test commands`
Expected: PASS.
Run: `cd src-tauri && cargo build`
Expected: builds without error.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: expose compute_diff and get_file_diff Tauri commands"
```

---

### Task 6: Frontend — typed IPC client + shared types

**Files:**
- Create: `src/types.ts`
- Create: `src/api.ts`
- Create: `src/api.test.ts`
- Modify: `package.json` (vitest), `vite.config.ts` (test config)
- Create: `src/test-setup.ts`

**Interfaces:**
- Consumes: the invoke command names + payload shapes (Task 5).
- Produces:
  - TS types: `DiffMode`, `Target`, `FileStatus`, `FileEntry`, `FileDiff`, `DiffSummary`
  - `api.computeDiff(target: Target): Promise<DiffSummary>`
  - `api.getFileDiff(target: Target, path: string): Promise<FileDiff>`

- [ ] **Step 1: Add vitest**

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

```ts
// vite.config.ts — add a test block to the existing defineConfig
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], globals: true },
});
```

```ts
// src/test-setup.ts
import "@testing-library/jest-dom";
```

```jsonc
// package.json — add to "scripts"
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Write the failing test (client maps invoke args)**

```ts
// src/api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { api } from "./api";
import type { Target } from "./types";

describe("api", () => {
  beforeEach(() => invokeMock.mockReset());

  it("computeDiff calls the command with the target", async () => {
    const target: Target = { repoPath: "/r", mode: "all-changes" };
    invokeMock.mockResolvedValue({ files: [], baseLabel: "main", headLabel: "x" });
    const res = await api.computeDiff(target);
    expect(invokeMock).toHaveBeenCalledWith("compute_diff", { target });
    expect(res.baseLabel).toBe("main");
  });

  it("getFileDiff passes target and path", async () => {
    const target: Target = { repoPath: "/r", mode: "uncommitted" };
    invokeMock.mockResolvedValue({ status: "modified", binary: false });
    await api.getFileDiff(target, "a.ts");
    expect(invokeMock).toHaveBeenCalledWith("get_file_diff", { target, path: "a.ts" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/api.test.ts`
Expected: FAIL — `./api` and `./types` not found.

- [ ] **Step 4: Implement types + client**

```ts
// src/types.ts
export type DiffMode = "all-changes" | "uncommitted" | "last-commit" | "branch-vs-base";

export interface Target {
  repoPath: string;
  mode: DiffMode;
  base?: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileEntry {
  path: string;
  oldPath?: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface FileDiff {
  oldFileName?: string | null;
  oldContent?: string | null;
  oldLang?: string | null;
  newFileName?: string | null;
  newContent?: string | null;
  newLang?: string | null;
  status: FileStatus;
  binary: boolean;
}

export interface DiffSummary {
  files: FileEntry[];
  baseLabel: string;
  headLabel: string;
}
```

```ts
// src/api.ts
import { invoke } from "@tauri-apps/api/core";
import type { Target, DiffSummary, FileDiff } from "./types";

export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> =>
    invoke("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> =>
    invoke("get_file_diff", { target, path }),
};
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test src/api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): typed IPC client and shared diff types"
```

---

### Task 7: Frontend — Files panel (list/tree toggle, status, stats, empty state)

**Files:**
- Create: `src/files/buildTree.ts`
- Create: `src/files/buildTree.test.ts`
- Create: `src/files/FilesPanel.tsx`
- Create: `src/files/FilesPanel.test.tsx`

**Interfaces:**
- Consumes: `FileEntry`, `FileStatus` (Task 6).
- Produces:
  - `function buildTree(files: FileEntry[]): TreeNode[]` where `interface TreeNode { name: string; path: string; kind: "dir" | "file"; entry?: FileEntry; children: TreeNode[] }`
  - `<FilesPanel files={FileEntry[]} selected={string | null} onSelect={(path: string) => void} />` — renders a `List | Tree` toggle, a `N files` header, status badges, and `+adds −dels`; shows "Nothing to review" when `files` is empty.

- [ ] **Step 1: Write the failing tree-builder test**

```ts
// src/files/buildTree.test.ts
import { describe, it, expect } from "vitest";
import { buildTree } from "./buildTree";
import type { FileEntry } from "../types";

const f = (path: string): FileEntry => ({ path, status: "modified", additions: 1, deletions: 0, binary: false });

describe("buildTree", () => {
  it("nests files under directory nodes", () => {
    const tree = buildTree([f("src/a.ts"), f("src/b/c.ts"), f("readme.md")]);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["readme.md", "src"]);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.kind).toBe("dir");
    expect(src.children.find((n) => n.name === "b")!.children[0].name).toBe("c.ts");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/files/buildTree.test.ts`
Expected: FAIL — `./buildTree` not found.

- [ ] **Step 3: Implement `buildTree`**

```ts
// src/files/buildTree.ts
import type { FileEntry } from "../types";

export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  entry?: FileEntry;
  children: TreeNode[];
}

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const entry of files) {
    const parts = entry.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path, kind: isFile ? "file" : "dir", children: [], entry: isFile ? entry : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/files/buildTree.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing FilesPanel test**

```tsx
// src/files/FilesPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import type { FileEntry } from "../types";

const files: FileEntry[] = [
  { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
];

describe("FilesPanel", () => {
  it("shows empty state when no files", () => {
    render(<FilesPanel files={[]} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });

  it("calls onSelect when a file row is clicked", () => {
    const onSelect = vi.fn();
    render(<FilesPanel files={files} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("toggles to List view", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /list/i }));
    expect(screen.getByText("src/a.ts")).toBeInTheDocument(); // full path in list mode
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test src/files/FilesPanel.test.tsx`
Expected: FAIL — `./FilesPanel` not found.

- [ ] **Step 7: Implement `FilesPanel`**

```tsx
// src/files/FilesPanel.tsx
import { useState } from "react";
import type { FileEntry, FileStatus } from "../types";
import { buildTree, type TreeNode } from "./buildTree";

const STATUS_LETTER: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function Stats({ e }: { e: FileEntry }) {
  return (
    <span className="stats">
      {e.additions > 0 && <span className="adds">+{e.additions}</span>}{" "}
      {e.deletions > 0 && <span className="dels">−{e.deletions}</span>}
    </span>
  );
}

function Row({ e, label, selected, onSelect }: { e: FileEntry; label: string; selected: boolean; onSelect: (p: string) => void }) {
  return (
    <div className={`frow status-${e.status}${selected ? " sel" : ""}`} onClick={() => onSelect(e.path)}>
      <span className="st">{STATUS_LETTER[e.status]}</span>
      <span className="fn">{label}</span>
      <Stats e={e} />
    </div>
  );
}

function TreeView({ nodes, selected, onSelect, depth = 0 }: { nodes: TreeNode[]; selected: string | null; onSelect: (p: string) => void; depth?: number }) {
  return (
    <>
      {nodes.map((n) =>
        n.kind === "file" ? (
          <div key={n.path} style={{ paddingLeft: depth * 12 }}>
            <Row e={n.entry!} label={n.name} selected={selected === n.path} onSelect={onSelect} />
          </div>
        ) : (
          <div key={n.path}>
            <div className="dirnode" style={{ paddingLeft: depth * 12 }}>{n.name}/</div>
            <TreeView nodes={n.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
          </div>
        )
      )}
    </>
  );
}

export function FilesPanel({ files, selected, onSelect }: { files: FileEntry[]; selected: string | null; onSelect: (path: string) => void }) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  if (files.length === 0) return <div className="files-empty">Nothing to review</div>;
  const viewed = 0; // wired in Plan 2
  return (
    <div className="files-panel">
      <div className="files-header">
        <span>{files.length} files</span>
        <span className="viewed-count">{viewed}/{files.length} viewed</span>
        <span className="toggle">
          <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>List</button>
          <button aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>Tree</button>
        </span>
      </div>
      <div className="files-list">
        {mode === "list"
          ? files.map((e) => <Row key={e.path} e={e} label={e.path} selected={selected === e.path} onSelect={onSelect} />)
          : <TreeView nodes={buildTree(files)} selected={selected} onSelect={onSelect} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run to verify pass**

Run: `pnpm test src/files/FilesPanel.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(ui): files panel with list/tree toggle, stats, empty state"
```

---

### Task 8: Frontend — DiffView (git-diff-view integration, isolated)

**Files:**
- Create: `src/diff/DiffView.tsx` (the ONLY file importing `@git-diff-view/*`)
- Create: `src/diff/toDiffFile.ts`
- Create: `src/diff/toDiffFile.test.ts`

**Interfaces:**
- Consumes: `FileDiff` (Task 6).
- Produces:
  - `function toDiffFile(fd: FileDiff): DiffFile` (builds a git-diff-view `DiffFile` from our `FileDiff`)
  - `<DiffView fileDiff={FileDiff} mode={"unified" | "split"} theme={"light" | "dark"} />`

- [ ] **Step 1: Write the failing adapter test**

```ts
// src/diff/toDiffFile.test.ts
import { describe, it, expect } from "vitest";
import { toDiffFile } from "./toDiffFile";
import type { FileDiff } from "../types";

const fd: FileDiff = {
  oldFileName: "a.ts", oldContent: "const x = 1\n", oldLang: "typescript",
  newFileName: "a.ts", newContent: "const x = 2\n", newLang: "typescript",
  status: "modified", binary: false,
};

describe("toDiffFile", () => {
  it("builds a DiffFile with split lines initialized", () => {
    const file = toDiffFile(fd);
    file.buildSplitDiffLines();
    expect(file.splitLineLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/diff/toDiffFile.test.ts`
Expected: FAIL — `./toDiffFile` not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/diff/toDiffFile.ts
import { generateDiffFile } from "@git-diff-view/file";
import type { FileDiff } from "../types";

export function toDiffFile(fd: FileDiff) {
  const file = generateDiffFile(
    fd.oldFileName ?? "",
    fd.oldContent ?? "",
    fd.newFileName ?? "",
    fd.newContent ?? "",
    fd.oldLang ?? "",
    fd.newLang ?? ""
  );
  file.init();
  return file;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/diff/toDiffFile.test.ts`
Expected: PASS. (If `splitLineLength` is not the exact accessor, build and assert on the rendered output instead — see Step 5's smoke test — and keep the adapter.)

- [ ] **Step 5: Implement the DiffView component (isolated import)**

```tsx
// src/diff/DiffView.tsx
import { useMemo } from "react";
import { DiffView as GitDiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { FileDiff } from "../types";
import { toDiffFile } from "./toDiffFile";

export function DiffView({ fileDiff, mode, theme = "light" }: { fileDiff: FileDiff; mode: "unified" | "split"; theme?: "light" | "dark" }) {
  if (fileDiff.binary) return <div className="diff-binary">Binary file — not shown</div>;
  const file = useMemo(() => {
    const f = toDiffFile(fileDiff);
    f.initTheme(theme);
    f.init();
    mode === "split" ? f.buildSplitDiffLines() : f.buildUnifiedDiffLines();
    return f;
  }, [fileDiff, mode, theme]);

  return (
    <GitDiffView
      diffFile={file}
      diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight
      diffViewTheme={theme}
    />
  );
}
```

- [ ] **Step 6: Smoke-test the render (no crash on real data)**

```tsx
// add to src/diff/toDiffFile.test.ts (or a new DiffView.test.tsx)
import { render } from "@testing-library/react";
import { DiffView } from "./DiffView";

it("DiffView renders modified file without crashing", () => {
  const { container } = render(<DiffView fileDiff={fd} mode="unified" />);
  expect(container.firstChild).toBeTruthy();
});

it("DiffView shows placeholder for binary", () => {
  const { getByText } = render(<DiffView fileDiff={{ ...fd, binary: true }} mode="unified" />);
  expect(getByText(/binary file/i)).toBeTruthy();
});
```

Run: `pnpm test src/diff`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): isolated DiffView wrapping git-diff-view + content adapter"
```

---

### Task 9: Frontend — Workspace shell wiring (top bar, mode selector, open-by-path)

**Files:**
- Create: `src/workspace/Workspace.tsx`
- Create: `src/workspace/Workspace.test.tsx`
- Modify: `src/App.tsx`
- Create: `src/styles.css`; Modify: `src/main.tsx` (import styles)

**Interfaces:**
- Consumes: `api` (Task 6), `FilesPanel` (Task 7), `DiffView` (Task 8), `Target`/`DiffMode` (Task 6).
- Produces: `<Workspace />` — the read-only review workspace: a repo-path input + Open, a mode selector (All changes / Uncommitted / Last commit / Branch vs base), a Refresh button, the files panel, and the diff pane. This is Plan 1's milestone deliverable.

- [ ] **Step 1: Write the failing workspace test (mode switch refetches)**

```tsx
// src/workspace/Workspace.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const computeDiff = vi.fn();
const getFileDiff = vi.fn();
vi.mock("../api", () => ({ api: { computeDiff: (...a: unknown[]) => computeDiff(...a), getFileDiff: (...a: unknown[]) => getFileDiff(...a) } }));
// DiffView is exercised in its own test; stub it here to keep this test about wiring.
vi.mock("../diff/DiffView", () => ({ DiffView: () => <div data-testid="diffview" /> }));

import { Workspace } from "./Workspace";

describe("Workspace", () => {
  beforeEach(() => { computeDiff.mockReset(); getFileDiff.mockReset(); });

  it("loads files after Open and refetches on mode change", async () => {
    computeDiff.mockResolvedValue({ files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false }], baseLabel: "main", headLabel: "feat" });
    render(<Workspace />);
    fireEvent.change(screen.getByPlaceholderText(/repo path/i), { target: { value: "/r" } });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    expect(computeDiff).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes" });

    fireEvent.click(screen.getByRole("button", { name: /uncommitted/i }));
    await waitFor(() => expect(computeDiff).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted" }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/workspace/Workspace.test.tsx`
Expected: FAIL — `./Workspace` not found.

- [ ] **Step 3: Implement the Workspace**

```tsx
// src/workspace/Workspace.tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffView } from "../diff/DiffView";
import type { DiffMode, DiffSummary, FileDiff, Target } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

export function Workspace() {
  const [repoPath, setRepoPath] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("all-changes");
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = useCallback((): Target => ({ repoPath: opened!, mode }), [opened, mode]);

  const load = useCallback(async () => {
    if (!opened) return;
    try {
      setError(null);
      setSelected(null);
      setFileDiff(null);
      setSummary(await api.computeDiff({ repoPath: opened, mode }));
    } catch (e) {
      setError(String(e));
    }
  }, [opened, mode]);

  useEffect(() => { load(); }, [load]);

  const open = () => setOpened(repoPath.trim() || null);

  const selectFile = async (path: string) => {
    setSelected(path);
    try {
      setFileDiff(await api.getFileDiff(target(), path));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="workspace">
      <div className="topbar">
        <input placeholder="Repo path" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <button onClick={open}>Open</button>
        {opened && (
          <>
            <span className="ctx">{summary?.baseLabel} → {summary?.headLabel}</span>
            <span className="modeseg">
              {MODES.map((m) => (
                <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </span>
            <button onClick={load}>Refresh</button>
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="body">
        {summary && <FilesPanel files={summary.files} selected={selected} onSelect={selectFile} />}
        <div className="diff-pane">
          {fileDiff ? <DiffView fileDiff={fileDiff} mode="unified" /> : <div className="diff-placeholder">Select a file</div>}
        </div>
      </div>
    </div>
  );
}
```

```tsx
// src/App.tsx
import { Workspace } from "./workspace/Workspace";
export default function App() {
  return <Workspace />;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/workspace/Workspace.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add minimal layout-B styling**

```css
/* src/styles.css */
:root { --border: #d1d1d6; --bg2: #fff; --bg3: #f5f5f7; --accent: #0071e3; --add: #1a7f37; --del: #cf222e; }
.workspace { display: flex; flex-direction: column; height: 100vh; font: 13px system-ui; }
.topbar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.modeseg button[aria-pressed="true"], .toggle button[aria-pressed="true"] { background: var(--accent); color: #fff; }
.body { flex: 1; display: flex; min-height: 0; }
.files-panel { width: 240px; border-right: 1px solid var(--border); overflow: auto; }
.files-header { display: flex; gap: 8px; padding: 6px 8px; font-size: 11px; color: #666; }
.frow { display: flex; gap: 8px; padding: 3px 8px; cursor: pointer; }
.frow.sel { background: #e8f4fd; }
.frow .st { width: 14px; text-align: center; }
.status-added .st { color: var(--add); } .status-deleted .st { color: var(--del); }
.adds { color: var(--add); } .dels { color: var(--del); }
.diff-pane { flex: 1; overflow: auto; }
.files-empty, .diff-placeholder { padding: 24px; color: #888; }
```

```tsx
// src/main.tsx — add this import near the top
import "./styles.css";
```

- [ ] **Step 6: Manual end-to-end verification in the real app**

```bash
pnpm tauri dev
```
- Type this repo's path (`/Users/dario.ielardi/projects/delta`) and click Open. (Make an uncommitted edit to a file first so there's something to show.)
- Expected: files panel lists changed files; clicking one renders the diff; switching modes refetches; an unchanged clean checkout shows "Nothing to review".

- [ ] **Step 7: Run the full suite + commit**

```bash
pnpm test && (cd src-tauri && cargo test)
git add -A
git commit -m "feat(ui): read-only review workspace (top bar, mode switch, diff pane)"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):**
- Tauri 2 + React/TS + Rust shell → Task 1. ✓
- git2 engine, four modes, base detection, merge-base, empty state → Tasks 2–4. ✓
- Generalized comparison (`from`/`right`) → Task 2 `Endpoints`/`RightSide`. ✓
- DiffView isolated behind one component → Task 8 (Global Constraint enforced). ✓
- Files panel: status, stats, list/tree toggle, empty state → Task 7. ✓
- Lazy per-file content fetch (large-diff perf) → Tasks 4–6, 9. ✓
- Mode selector = re-fetch → Task 9. ✓
- Deferred to Plan 2/3 (intentionally not here): comments, persistence, anchoring, viewed checkbox (UI stub only in Task 7), picker, CLI, multi-window, export. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style gaps; every code step has real code. The one tolerance: Task 8 Step 4 notes a fallback assertion if `splitLineLength` is not the exact accessor — the adapter itself is concrete.

**Type consistency:** `Target`/`DiffMode`/`FileStatus`/`FileEntry`/`FileDiff`/`DiffSummary` are defined once in Rust (Tasks 2–4) and mirrored once in TS (Task 6); command names `compute_diff`/`get_file_diff` match between Task 5 and Task 6; `FilesPanel`/`DiffView` props match their consumers in Task 9.

**Known risk to watch:** the exact `@git-diff-view/file` `DiffFile` accessor names (`buildSplitDiffLines`, `splitLineLength`, `initTheme`) are from docs; if an accessor differs at the pinned version, fix it in Task 8 only (it's isolated) — no ripple.

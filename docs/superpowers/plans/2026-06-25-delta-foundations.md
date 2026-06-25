# delta — Plan 1: Foundations & Diff Viewing (read-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tauri 2 + React/TS shell and a Rust git engine so you can open a repo, pick a diff mode, and view the rendered diff (files panel + git-diff-view) — read-only, no comments yet.

**Architecture:** Rust (git2) owns repo access, target/ref resolution, the changed-file set, status, rename detection, and per-file old/new **content**. The React frontend calls two Tauri commands (`compute_diff`, `get_file_diff`) and renders with `@git-diff-view/react`, which computes the intra-file line diff from content via `generateDiffFile`. Diff content is fetched lazily per file (only when selected) to keep large diffs fast.

**Tech Stack:** Tauri 2; Rust + git2; React 19 + TypeScript + Vite + React Compiler; Tailwind v4 + shadcn/ui (Luma preset) + lucide-react; `react-arborist`; `@git-diff-view/react` + `@git-diff-view/file` 0.1.6; vitest + @testing-library/react + happy-dom; tempfile + git2 (Rust tests).

## Global Constraints

- **Startup target:** <1s; keep dependencies lean, lazy-load diff content per file.
- **Renderer is isolated:** all `@git-diff-view/*` usage lives behind a single `DiffView` React component. No other file imports git-diff-view.
- **Renderer version pinned:** `@git-diff-view/react` and `@git-diff-view/file` at exactly **0.1.6** (no `^`).
- **Diff modes (preset ids, serialized kebab-case):** `all-changes` (default), `uncommitted`, `last-commit`, `branch-vs-base`.
- **`all-changes` = `merge-base(base) → working tree`** (the hero/default mode). Base = auto-detected default branch (`origin/HEAD` → `main` → `master`), overridable.
- **Empty diff → "Nothing to review" empty state.** No automatic mode fallback.
- **Nothing is ever written into the user's repo / working tree.**
- **Rust↔TS payloads are camelCase** (`#[serde(rename_all = "camelCase")]`); enum values kebab-case/lowercase as specified per type.
- **Package manager is pnpm.** Use `pnpm` for everything: `pnpm install`, `pnpm <script>`, `pnpm tauri dev`. Add deps with `pnpm add` (`-D` dev, `-E` exact). Scaffold with `--manager pnpm`. (pnpm only affects the JS frontend; the Rust/cargo build is unaffected.)
- **React 19 + React Compiler.** Auto-memoization is on; **do not hand-write `useMemo`/`useCallback`/`React.memo`** unless profiling proves a need. Wired via `babel-plugin-react-compiler` in the Vite React babel config; `eslint-plugin-react-hooks` enforces the Rules of React it relies on.
- **Ecosystem-first — never reinvent.** Use well-adopted libraries, never hand-roll equivalents: **UI** = Tailwind v4 + shadcn/ui (Radix) + `lucide-react`; **file tree** = `react-arborist`; **command palette / picker** = `cmdk` (Plan 3); **markdown** = `react-markdown` (Plan 2); **diff** = git-diff-view. Hand-write only genuinely app-specific logic (git engine, anchoring, serializer, thin glue). Same principle in Rust (e.g., the `similar` crate for fuzzy matching in Plan 2).
- **Look & feel — modern + native.** Apply the shadcn **Luma** preset (`b2D0wqNxT`) via `shadcn init --preset b2D0wqNxT`. Then **override the font** to a **monospace UI stack** (`--font-sans`/`--font-mono` = `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace` — native SF Mono on macOS; this intentionally supersedes Luma's font, per the mono-font requirement). **Follow the system light/dark appearance** (`prefers-color-scheme`); git-diff-view's theme tracks the same.
- **Frontend tests run on `happy-dom`** (vitest `environment: 'happy-dom'`).

**Design note (now reflected in spec §5 & §7):** Rust does not emit git hunk strings; git-diff-view computes the line diff from old/new content. Rust remains the source of truth for *which* files changed, their status, renames, and content. Revisit if exact git-algorithm parity is ever required.

---

### Task 1: Project scaffold + frontend toolchain (Tauri 2, React 19, Tailwind v4 + shadcn/ui, React Compiler, vitest/happy-dom)

**Files:**
- Scaffold/modify: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/test-setup.ts`, `src/theme.ts`
- Create via shadcn: `components.json`, `src/lib/utils.ts`, `src/components/ui/*`
- Scaffold: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`

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

- [ ] **Step 2: Install, then bump to React 19**

```bash
pnpm install
pnpm add react@^19 react-dom@^19
pnpm add -D @types/react@^19 @types/react-dom@^19
```

- [ ] **Step 3: Pin the diff renderer (exact 0.1.6)**

```bash
pnpm add -E @git-diff-view/react@0.1.6 @git-diff-view/file@0.1.6
```

- [ ] **Step 4: Add Tailwind v4 + the `@` path alias**

```bash
pnpm add tailwindcss @tailwindcss/vite
pnpm add -D @types/node
```

Add the alias to `tsconfig.json` **and** `tsconfig.app.json` (under `compilerOptions`):

```jsonc
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

- [ ] **Step 5: Add React Compiler + the compiler ESLint rule**

```bash
pnpm add -D -E babel-plugin-react-compiler@latest
pnpm add -D eslint-plugin-react-hooks@latest
```

- [ ] **Step 6: Add vitest + happy-dom**

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom happy-dom
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

- [ ] **Step 7: Write the consolidated `vite.config.ts`**

Edit the scaffolded config to add the React Compiler babel plugin, Tailwind, the `@` alias, and the vitest block. **Keep any Tauri-specific `server`/`envPrefix` settings the scaffold generated.**

```ts
/// <reference types="vitest" />
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
    tailwindcss(),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // --- keep the Tauri settings the scaffold generated, e.g.: ---
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: "happy-dom", setupFiles: ["./src/test-setup.ts"], globals: true },
});
```

- [ ] **Step 8: Initialize shadcn/ui with the Luma preset and add the components Plan 1 uses**

```bash
pnpm dlx shadcn@latest init --preset b2D0wqNxT   # applies the "Luma" theme (colors, radius, fonts) + base config
pnpm dlx shadcn@latest add button toggle-group checkbox scroll-area tooltip
```

`init --preset` writes `components.json`, `src/lib/utils.ts`, and Luma's theme tokens (`:root` + `.dark`) into `src/index.css`; `lucide-react` is pulled in as a dependency. (Luma's `.dark` block is what the system-theme hook in Step 9 toggles.)

- [ ] **Step 9: Set the monospace font + system light/dark**

Append to `src/index.css` — this **overrides the font Luma set** with a monospace stack (resolves to native SF Mono on macOS), per the mono-font requirement:

```css
@theme inline {
  --font-sans: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}

@layer base {
  body { font-family: var(--font-sans); }
}
```

Make shadcn's `.dark` follow the OS and expose a hook (git-diff-view's theme reuses it):

```ts
// src/theme.ts
import { useEffect, useState } from "react";

const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

export function useSystemTheme(): "light" | "dark" {
  const [dark, setDark] = useState(() => mql().matches);
  useEffect(() => {
    const m = mql();
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return dark ? "dark" : "light";
}
```

- [ ] **Step 10: Prove the toolchain — `src/main.tsx` + `src/App.tsx`**

Ensure `src/main.tsx` imports the stylesheet:

```tsx
// src/main.tsx (key line)
import "./index.css";
```

```tsx
// src/App.tsx
import { Button } from "@/components/ui/button";
import { useSystemTheme } from "./theme";

export default function App() {
  useSystemTheme();
  return (
    <div data-testid="app-root" className="p-4">
      <span>delta</span>
      <Button className="ml-2">OK</Button>
    </div>
  );
}
```

- [ ] **Step 11: Verify boot + a smoke test**

```bash
pnpm tauri dev   # window shows "delta" + a styled (mono) shadcn Button; Ctrl-C to stop
```

```tsx
// src/smoke.test.tsx
import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import App from "./App";

it("renders the app root with the toolchain wired", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeInTheDocument();
});
```

Run: `pnpm test smoke`
Expected: PASS — confirms Tailwind, shadcn, React Compiler, and happy-dom work together.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + React 19 toolchain (Tailwind v4, shadcn New York, React Compiler, vitest/happy-dom, mono theme)"
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

(vitest + happy-dom, the `vite.config.ts` test block, `src/test-setup.ts`, and the `test` scripts were all set up in Task 1.)

**Interfaces:**
- Consumes: the invoke command names + payload shapes (Task 5).
- Produces:
  - TS types: `DiffMode`, `Target`, `FileStatus`, `FileEntry`, `FileDiff`, `DiffSummary`
  - `api.computeDiff(target: Target): Promise<DiffSummary>`
  - `api.getFileDiff(target: Target, path: string): Promise<FileDiff>`

- [ ] **Step 1: Toolchain check (no-op)**

vitest + happy-dom, the `vite.config.ts` test block, `src/test-setup.ts`, and the `test`/`test:watch` scripts were all created in Task 1. Confirm `pnpm test smoke` still passes, then continue.

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
  - `function buildTree(files: FileEntry[]): TreeNode[]` where `interface TreeNode { id: string; name: string; path: string; kind: "dir" | "file"; entry?: FileEntry; children: TreeNode[] }` (`id` = path, required by react-arborist)
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
  id: string; // = path; required by react-arborist
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
        child = { id: path, name: part, path, kind: isFile ? "file" : "dir", children: [], entry: isFile ? entry : undefined };
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
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import type { FileEntry } from "../types";

const files: FileEntry[] = [
  { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
];

describe("FilesPanel", () => {
  it("shows the empty state when there are no files", () => {
    render(<FilesPanel files={[]} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });

  it("renders the header, file count, toggle, and tree container", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(/1 files/)).toBeInTheDocument();
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /list/i })).toBeInTheDocument();
  });
});
```

> Note: react-arborist only renders rows once its container is measured (ResizeObserver), which happy-dom doesn't lay out — so row rendering and click-to-select are verified in Task 9's end-to-end step, not here. The pure tree-shaping logic is fully covered by `buildTree`'s unit test above.

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test src/files/FilesPanel.test.tsx`
Expected: FAIL — `./FilesPanel` not found.

- [ ] **Step 7: Implement `FilesPanel`**

```tsx
// src/files/FilesPanel.tsx
import { useLayoutEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FileEntry, FileStatus } from "../types";
import { buildTree, type TreeNode } from "./buildTree";

const STATUS_LETTER: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-emerald-600", modified: "text-amber-600", deleted: "text-red-600", renamed: "text-blue-600",
};

// react-arborist needs explicit pixel dimensions; measure the container.
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

function FileNode({ node, style }: NodeRendererProps<TreeNode>) {
  const data = node.data;
  const isDir = data.kind === "dir";
  return (
    <div
      style={style}
      className={`flex items-center gap-2 px-2 text-xs cursor-pointer rounded-sm ${node.isSelected ? "bg-accent" : "hover:bg-muted"}`}
      onClick={() => (isDir ? node.toggle() : node.select())}
    >
      {isDir ? (
        node.isOpen ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
      ) : (
        <span className={`w-3.5 text-center font-semibold ${STATUS_COLOR[data.entry!.status]}`}>
          {STATUS_LETTER[data.entry!.status]}
        </span>
      )}
      <span className="truncate flex-1">{data.name}{isDir ? "/" : ""}</span>
      {!isDir && data.entry && (
        <span className="shrink-0 tabular-nums">
          {data.entry.additions > 0 && <span className="text-emerald-600">+{data.entry.additions}</span>}{" "}
          {data.entry.deletions > 0 && <span className="text-red-600">−{data.entry.deletions}</span>}
        </span>
      )}
    </div>
  );
}

export function FilesPanel({ files, selected, onSelect }: { files: FileEntry[]; selected: string | null; onSelect: (path: string) => void }) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const { ref, width, height } = useSize();

  if (files.length === 0) return <div className="files-empty p-6 text-muted-foreground text-sm">Nothing to review</div>;

  // tree mode = nested; list mode = flat leaves (react-arborist renders both shapes).
  const data: TreeNode[] =
    mode === "tree"
      ? buildTree(files)
      : files.map((e) => ({ id: e.path, name: e.path, path: e.path, kind: "file", entry: e, children: [] }));

  const viewed = 0; // viewed checkbox + count wired in Plan 2

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground border-b">
        <span>{files.length} files</span>
        <span className="ml-auto">{viewed}/{files.length} viewed</span>
        <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as "tree" | "list")}>
          <ToggleGroupItem value="list">List</ToggleGroupItem>
          <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div ref={ref} data-testid="files-tree" className="flex-1 min-h-0">
        {width > 0 && (
          <Tree<TreeNode>
            data={data}
            openByDefault
            width={width}
            height={height}
            rowHeight={24}
            indent={12}
            selection={selected ?? undefined}
            onSelect={(nodes) => {
              const n = nodes[0];
              if (n && n.data.kind === "file") onSelect(n.data.path);
            }}
          >
            {FileNode}
          </Tree>
        )}
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
import { DiffView as GitDiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { FileDiff } from "../types";
import { toDiffFile } from "./toDiffFile";

export function DiffView({ fileDiff, mode, theme = "light" }: { fileDiff: FileDiff; mode: "unified" | "split"; theme?: "light" | "dark" }) {
  if (fileDiff.binary) return <div className="text-muted-foreground p-6 text-sm">Binary file — not shown</div>;

  // No useMemo — React Compiler handles memoization (Global Constraints).
  const file = toDiffFile(fileDiff); // adapter already calls .init()
  file.initTheme(theme);
  mode === "split" ? file.buildSplitDiffLines() : file.buildUnifiedDiffLines();

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
- Modify: `src/App.tsx` (render `<Workspace />`)

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
    await waitFor(() => expect(screen.getByText(/1 files/)).toBeInTheDocument()); // FilesPanel header (arborist rows need layout; see Task 7 note)
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
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffView } from "../diff/DiffView";
import { useSystemTheme } from "../theme";
import type { DiffMode, DiffSummary, FileDiff } from "../types";

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
  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No useCallback — React Compiler handles memoization (Global Constraints).
  async function load(repo: string, m: DiffMode) {
    try {
      setError(null);
      setSelected(null);
      setFileDiff(null);
      setSummary(await api.computeDiff({ repoPath: repo, mode: m }));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (opened) load(opened, mode);
  }, [opened, mode]);

  async function selectFile(path: string) {
    if (!opened) return;
    setSelected(path);
    try {
      setFileDiff(await api.getFileDiff({ repoPath: opened, mode }, path));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col h-screen text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <input
          className="border rounded px-2 py-1 text-xs bg-background"
          placeholder="Repo path"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
        <Button size="sm" variant="secondary" onClick={() => setOpened(repoPath.trim() || null)}>Open</Button>
        {opened && (
          <>
            <span className="text-xs text-muted-foreground">{summary?.baseLabel} → {summary?.headLabel}</span>
            <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as DiffMode)} className="ml-2">
              {MODES.map((m) => (
                <ToggleGroupItem key={m.id} value={m.id}>{m.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => load(opened, mode)}>Refresh</Button>
          </>
        )}
      </div>
      {error && <div className="px-3 py-1 text-red-600 text-xs">{error}</div>}
      <div className="flex flex-1 min-h-0">
        {summary && (
          <div className="w-60 border-r min-h-0">
            <FilesPanel files={summary.files} selected={selected} onSelect={selectFile} />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {fileDiff ? (
            <DiffView fileDiff={fileDiff} mode="unified" theme={theme} />
          ) : (
            <div className="p-6 text-muted-foreground">Select a file</div>
          )}
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

- [ ] **Step 5: Styling — Tailwind + Luma tokens (nothing to add)**

All components above use Tailwind utilities + shadcn/Luma theme tokens (`bg-background`, `text-muted-foreground`, `bg-accent`, `border`), so light/dark follows the system theme automatically (Task 1). `src/main.tsx` already imports `src/index.css`. No stylesheet to add.

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

**Toolchain / look-and-feel coverage:** the Luma preset (`shadcn init --preset b2D0wqNxT`), the mono-font override, system light/dark, the ecosystem stack (Tailwind/shadcn/lucide/react-arborist), React Compiler (no hand-memo), happy-dom, and the 0.1.6 renderer pin all live in Global Constraints + Task 1. Second known risk: **react-arborist renders no rows under happy-dom** (no layout), so file-row rendering/selection is verified in Task 9's manual e2e rather than unit tests — `buildTree` carries the unit-tested tree logic.

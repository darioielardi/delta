# Commit-by-commit Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer step through a branch one commit at a time, leaving comments tagged to the commit they're viewing.

**Architecture:** A new `DiffMode::Commit` + `Target.commit` lets the existing tree-vs-tree diff engine render a single commit's isolated `parent→commit` diff. The frontend keeps `diffMode` as the four canonical scopes and layers a separate `commitOid` overlay on top — so the persisted review's canonical target never becomes "commit", and untagged comments never re-anchor against a single commit. Comments carry an optional `commit` oid; because a commit is immutable, tagged comments freeze on reconcile (stale only if the oid leaves the branch range). Commit selection lives in a shadcn dropdown-menu submenu; a small prev/next stepper appears only in commit mode.

**Tech Stack:** Rust + git2 (backend), React 19 + TypeScript + Tailwind v4 + shadcn/radix-ui (frontend), Vitest + happy-dom (FE tests), cargo test (BE tests).

## Global Constraints

- **Conventional Commits** for every commit message.
- Keep diffs tightly scoped; do not refactor unrelated code.
- When changing a Tauri command, update all three layers: `src-tauri/src/commands.rs`, `src/api.ts`, `src/dev/mockBackend.ts`.
- shadcn primitives import from the unified `radix-ui` package (e.g. `import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"`), matching `src/components/ui/*.tsx`.
- Styling uses existing oklch tokens (`--primary`, `--muted`, `--border`, etc.); no hardcoded colors.
- Run `npx tsc --noEmit` and `pnpm test` before any FE commit; `cargo test` (in `src-tauri/`) before any BE commit.
- Validate UI via `pnpm dev:mock` (port 5599) — there is no tauri-driver on macOS.

---

## Task 1: Backend — `DiffMode::Commit` + `Target.commit` + isolated commit endpoints

**Files:**
- Modify: `src-tauri/src/git/model.rs`
- Modify: `src-tauri/src/git/mod.rs` (`resolve_endpoints`)
- Modify (literals only): `src-tauri/src/git/diff.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/review/reconcile.rs`, `src-tauri/src/export/mod.rs`, `src-tauri/src/storage/mod.rs`, `src-tauri/src/registry/model.rs`
- Test: `src-tauri/src/git/mod.rs` (tests module)

**Interfaces:**
- Produces: `DiffMode::Commit` (serializes `"commit"`); `Target.commit: Option<String>`; `resolve_endpoints` handles `Commit` by diffing `parent(0).tree() → commit.tree()` (root commit → empty tree on the left).

- [ ] **Step 1: Add the `Commit` variant and `commit` field**

In `src-tauri/src/git/model.rs`, extend the enum and struct:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffMode {
    AllChanges,
    Uncommitted,
    LastCommit,
    BranchVsBase,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub mode: DiffMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}
```

And add the `as_str` arm:

```rust
            DiffMode::BranchVsBase => "branch-vs-base",
            DiffMode::Commit => "commit",
```

- [ ] **Step 2: Add the `Commit` arm to `resolve_endpoints`**

In `src-tauri/src/git/mod.rs`, inside `resolve_endpoints`'s `match target.mode`, add (after the `LastCommit` arm):

```rust
        DiffMode::Commit => {
            let oid = target
                .commit
                .as_deref()
                .ok_or_else(|| "commit mode requires a commit oid".to_string())?;
            let commit = repo
                .revparse_single(oid)
                .and_then(|o| o.peel_to_commit())
                .map_err(|e| format!("commit {oid}: {e}"))?;
            // Isolated diff: parent(0) → commit. Root commit → empty left tree.
            let from_tree = match commit.parent(0) {
                Ok(parent) => Some(tree_of(repo, parent.id())?.id()),
                Err(_) => None,
            };
            Ok(Endpoints {
                from_tree,
                right: RightSide::Tree(tree_of(repo, commit.id())?.id()),
                base_label: commit
                    .parent(0)
                    .map(|p| short_oid(p.id()))
                    .unwrap_or_else(|_| "∅".into()),
                head_label: short_oid(commit.id()),
            })
        }
```

- [ ] **Step 3: Make every `Target { … }` literal compile**

`cargo build` (in `src-tauri/`) now fails with `missing field commit` at each literal. Add `commit: None` to every one. Run:

```bash
cd src-tauri && cargo build 2>&1 | grep -A2 "missing field"
```

Add `commit: None` to each reported literal (in `git/diff.rs`, `commands.rs`, `review/reconcile.rs`, `export/mod.rs`, `storage/mod.rs`, `registry/model.rs`, and any test helper that builds `Target`). Re-run until it compiles clean.

- [ ] **Step 4: Write the failing tests**

Add to the `tests` module in `src-tauri/src/git/mod.rs`:

```rust
    #[test]
    fn commit_mode_diffs_parent_to_commit() {
        use crate::git::diff::compute_diff;
        let (dir, repo) = repo_with_commit(); // main: file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let oid = commit_all(&repo, "second");
        let summary = compute_diff(&Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Commit,
            base: None,
            commit: Some(oid.to_string()),
        })
        .unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");
        assert_eq!(summary.files[0].additions, 1);
    }

    #[test]
    fn commit_mode_root_commit_is_all_additions() {
        use crate::git::diff::compute_diff;
        let (dir, repo) = repo_with_commit(); // the initial commit IS the root
        let root = repo.head().unwrap().peel_to_commit().unwrap().id();
        let summary = compute_diff(&Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Commit,
            base: None,
            commit: Some(root.to_string()),
        })
        .unwrap();
        let f = summary.files.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(f.status, crate::git::diff::FileStatus::Added);
    }
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test commit_mode_ 2>&1 | tail -20
```
Expected: both PASS.

- [ ] **Step 6: Run the full Rust suite (no regressions from the literal churn)**

```bash
cd src-tauri && cargo test 2>&1 | tail -15
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat(git): add Commit diff mode for isolated parent->commit diffs"
```

---

## Task 2: Backend — `list_commits` command (`git/log.rs`)

**Files:**
- Create: `src-tauri/src/git/log.rs`
- Modify: `src-tauri/src/git/mod.rs` (add `pub mod log;`)
- Modify: `src-tauri/src/commands.rs` (impl + command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Test: `src-tauri/src/git/log.rs` (tests module)

**Interfaces:**
- Produces: `CommitMeta { oid: String, short_oid: String, subject: String, author: String, time: i64 }`; `list_commits(repo: &Repository, target: &Target) -> Result<Vec<CommitMeta>, GitError>` (newest-first, `merge-base(base,HEAD)..HEAD`); `#[tauri::command] list_commits(target: Target) -> Result<Vec<CommitMeta>, String>`.

- [ ] **Step 1: Write the failing test (create the file with test first)**

Create `src-tauri/src/git/log.rs`:

```rust
use crate::git::model::Target;
use crate::git::{open_repo, resolve_base, GitError};
use git2::Sort;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

/// Commits on `merge-base(base, HEAD)..HEAD`, newest first.
pub fn list_commits(target: &Target) -> Result<Vec<CommitMeta>, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_oid = head.peel_to_commit().map_err(|e| format!("head commit: {e}"))?.id();
    let (_label, base_oid) = resolve_base(&repo, target.base.as_deref())?;
    let mb = repo.merge_base(head_oid, base_oid).map_err(|e| format!("merge-base: {e}"))?;

    let mut walk = repo.revwalk().map_err(|e| format!("revwalk: {e}"))?;
    walk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;
    if mb != head_oid {
        walk.hide(mb).map_err(|e| e.to_string())?;
    }

    let mut out = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.to_string())?;
        let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
        out.push(CommitMeta {
            oid: oid.to_string(),
            short_oid: oid.to_string().chars().take(7).collect(),
            subject: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::DiffMode;
    use crate::git::test_support::*;

    fn target(repo_path: &str) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode: DiffMode::Commit, base: None, commit: None }
    }

    #[test]
    fn lists_branch_commits_newest_first_excluding_base() {
        let (dir, repo) = repo_with_commit(); // main @ "initial"
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "a.txt", "1\n");
        let c1 = commit_all(&repo, "first on feature");
        write(dir.path(), "b.txt", "2\n");
        let c2 = commit_all(&repo, "second on feature");

        let commits = list_commits(&target(dir.path().to_str().unwrap())).unwrap();
        let oids: Vec<&str> = commits.iter().map(|c| c.oid.as_str()).collect();
        assert_eq!(oids, vec![c2.to_string(), c1.to_string()]); // newest first
        assert_eq!(commits[0].subject, "second on feature");
    }

    #[test]
    fn empty_when_head_is_base() {
        let (dir, _repo) = repo_with_commit(); // on main, no commits ahead of base(main)
        let commits = list_commits(&target(dir.path().to_str().unwrap())).unwrap();
        assert!(commits.is_empty());
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/git/mod.rs`, add near the other `pub mod` lines:

```rust
pub mod log;
```

- [ ] **Step 3: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test --lib git::log 2>&1 | tail -15
```
Expected: both PASS. (Note `resolve_base` is already `pub` in `git/mod.rs`.)

- [ ] **Step 4: Add the command impl + wrapper**

In `src-tauri/src/commands.rs`, add the import and command. Near the top imports:

```rust
use crate::git::log::{list_commits as engine_list_commits, CommitMeta};
```

Add an impl beside `compute_diff_impl`:

```rust
pub fn list_commits_impl(target: Target) -> Result<Vec<CommitMeta>, String> {
    engine_list_commits(&target)
}
```

Add the command beside `compute_diff`:

```rust
#[tauri::command]
pub async fn list_commits(target: Target) -> Result<Vec<CommitMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || list_commits_impl(target))
        .await
        .map_err(|e| format!("list_commits task: {e}"))?
}
```

- [ ] **Step 5: Register in the invoke handler**

In `src-tauri/src/lib.rs`, find `tauri::generate_handler![ … ]` and add `commands::list_commits,` alongside `commands::compute_diff,`.

```bash
grep -n "compute_diff" src-tauri/src/lib.rs
```
Add the entry next to it.

- [ ] **Step 6: Build + test**

```bash
cd src-tauri && cargo test 2>&1 | tail -15
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat(git): add list_commits command for the branch's commits"
```

---

## Task 3: Backend — `Comment.commit` + reconcile freeze for tagged comments

**Files:**
- Modify: `src-tauri/src/review/model.rs`
- Modify: `src-tauri/src/review/reconcile.rs`
- Modify (literals only): `src-tauri/src/export/mod.rs` (tests), `src-tauri/src/commands.rs` (tests)
- Test: `src-tauri/src/review/reconcile.rs` (tests module)

**Interfaces:**
- Consumes: `crate::git::log::list_commits`.
- Produces: `Comment.commit: Option<String>`. Reconcile rule: a comment with `commit = Some(oid)` is frozen — `stale = !present_commit_oids.contains(oid)`, anchor untouched; `commit = None` reconciles as before.

- [ ] **Step 1: Add the `commit` field to `Comment`**

In `src-tauri/src/review/model.rs`, inside `struct Comment`, after `pub resolved: bool,` add:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
```

- [ ] **Step 2: Make `Comment { … }` literals compile**

```bash
cd src-tauri && cargo build 2>&1 | grep -A2 "missing field"
```
Add `commit: None` to each reported `Comment { … }` literal (test helpers in `export/mod.rs`, `commands.rs`, `reconcile.rs`, and the `model.rs` doctest/test if any). Re-run until clean. The legacy-JSON deserialize test in `model.rs` still passes (the field defaults).

- [ ] **Step 3: Write the failing tests**

Add to the `tests` module in `src-tauri/src/review/reconcile.rs` (helpers `repo_with_commit`, `write`, `commit_all`, `empty_review`, `line_comment` already exist there):

```rust
    fn tagged_comment(file: &str, line: u32, snippet: &str, commit: &str) -> Comment {
        let mut c = line_comment(file, line, snippet);
        c.commit = Some(commit.to_string());
        c
    }

    #[test]
    fn tagged_comment_stays_fresh_when_its_commit_is_present() {
        let (dir, repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let oid = commit_all(&repo, "second");
        let mut r = empty_review(dir.path().to_str().unwrap());
        // canonical mode = branch-vs-base so the diff covers the branch
        r.target.mode = crate::git::model::DiffMode::BranchVsBase;
        r.comments.push(tagged_comment("file.txt", 2, "ADDED", &oid.to_string()));
        let session = reconcile(r).unwrap();
        assert!(!session.review.comments[0].stale);
    }

    #[test]
    fn tagged_comment_goes_stale_when_its_commit_is_gone() {
        let (dir, _repo) = repo_with_commit();
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.target.mode = crate::git::model::DiffMode::BranchVsBase;
        r.comments.push(tagged_comment("file.txt", 1, "line1", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
        let session = reconcile(r).unwrap();
        assert!(session.review.comments[0].stale, "unknown commit oid => stale");
    }
```

- [ ] **Step 4: Implement the freeze in `reconcile`**

In `src-tauri/src/review/reconcile.rs`, add an import:

```rust
use crate::git::log::list_commits;
```

At the start of the comment-reconcile loop (before `for comment in &mut review.comments`), compute the present-commit set (best-effort: an empty set just means tagged comments fall through to stale, which the second test exercises):

```rust
    let present_commits: std::collections::HashSet<String> = list_commits(&review.target)
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.oid)
        .collect();
```

Then, as the first check inside the loop, handle tagged comments before the existing anchor logic:

```rust
    for comment in &mut review.comments {
        // Commit-tagged comments are frozen: the commit is immutable, so the
        // anchor never needs re-checking — it's stale only if rewritten away.
        if let Some(oid) = comment.commit.clone() {
            comment.stale = !present_commits.contains(&oid);
            continue;
        }
        let Some(anchor) = comment.anchor.as_mut() else {
            continue; // general note — no anchor
        };
        // … existing untagged logic unchanged …
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --lib review::reconcile 2>&1 | tail -20
```
Expected: the two new tests PASS, existing reconcile tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src
git commit -m "feat(review): tag comments with their commit and freeze them on reconcile"
```

---

## Task 4: Backend — export annotates commit-tagged comments

**Files:**
- Modify: `src-tauri/src/export/mod.rs`
- Test: `src-tauri/src/export/mod.rs` (tests module)

**Interfaces:**
- Consumes: `Comment.commit`.
- Produces: tagged comments render a `· commit <short>` marker in the markdown.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `src-tauri/src/export/mod.rs`:

```rust
    #[test]
    fn commit_tag_is_rendered() {
        let mut c = cmt(
            CommentScope::Line,
            Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("export const TTL = 3600".into()) }),
            "make configurable",
            false,
            false,
        );
        c.commit = Some("a1b2c3d4e5f6a7b8c9d0".into());
        let md = export_markdown(&review_with(vec![c]));
        assert!(md.contains("commit a1b2c3d"), "expected short commit marker, got:\n{md}");
    }
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd src-tauri && cargo test --lib export::tests::commit_tag_is_rendered 2>&1 | tail -10
```
Expected: FAIL (marker absent).

- [ ] **Step 3: Implement the marker**

In `src-tauri/src/export/mod.rs`, in the per-comment formatting (where `side_note` is built, around the line-scope header), add a commit marker. After the existing `let side_note = …;` line, add:

```rust
            let commit_note = match &c.commit {
                Some(oid) => format!(" · commit {}", oid.chars().take(7).collect::<String>()),
                None => String::new(),
            };
```

Then append `{commit_note}` to the same header line that already includes `{side_note}`. (Find the `format!`/`push_str` that writes `side_note` and add `{commit_note}` directly after it.)

- [ ] **Step 4: Run the test + full export suite**

```bash
cd src-tauri && cargo test --lib export 2>&1 | tail -15
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/export
git commit -m "feat(export): annotate commit-tagged comments in the agent markdown"
```

---

## Task 5: Frontend — types, api, route, and mock backend

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/route.ts`
- Modify: `src/dev/mockBackend.ts`
- Test: `src/route.test.ts`

**Interfaces:**
- Produces: `DiffMode` includes `"commit"`; `Target.commit?: string`; `Comment.commit?: string`; `CommitMeta` type; `api.listCommits(target): Promise<CommitMeta[]>`. Mock: `list_commits` returns `COMMITS`; `compute_diff`/`get_file_diff` honor `mode === "commit"`.

- [ ] **Step 1: Extend the types**

In `src/types.ts`:

```ts
export type DiffMode = "all-changes" | "uncommitted" | "last-commit" | "branch-vs-base" | "commit";

export interface Target {
  repoPath: string;
  mode: DiffMode;
  base?: string;
  worktree?: string;
  commit?: string;
}
```

Add `commit?: string | null;` to `interface Comment` (after `resolved`). Add a new type:

```ts
export interface CommitMeta {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  time: number;
}
```

- [ ] **Step 2: Add the api method**

In `src/api.ts`, add `CommitMeta` to the type import and add to the `api` object:

```ts
  listCommits: (target: Target): Promise<CommitMeta[]> =>
    invokeImpl("list_commits", { target }),
```

- [ ] **Step 3: Write the failing route test**

Add to `src/route.test.ts`:

```ts
it("parses the commit oid into the target", () => {
  const r = resolveRoute("review-x", "?view=review&repo=/r&mode=commit&commit=a1b2c3d");
  expect(r).toEqual({ kind: "review", target: { repoPath: "/r", mode: "commit", base: undefined, commit: "a1b2c3d" } });
});
```

- [ ] **Step 4: Update the route parser**

In `src/route.ts`:

```ts
const MODES: DiffMode[] = ["all-changes", "uncommitted", "last-commit", "branch-vs-base", "commit"];

export function resolveRoute(label: string | null, search: string): Route {
  const params = new URLSearchParams(search);
  const isReview = (label?.startsWith("review-") ?? false) || params.get("view") === "review";
  if (!isReview) return { kind: "home" };

  const repoPath = params.get("repo") ?? "";
  const modeParam = params.get("mode");
  const mode = (MODES.includes(modeParam as DiffMode) ? modeParam : "all-changes") as DiffMode;
  const base = params.get("base") ?? undefined;
  const commit = params.get("commit") ?? undefined;
  return { kind: "review", target: { repoPath, mode, base, commit } };
}
```

- [ ] **Step 5: Run the route test**

```bash
pnpm test -- route.test 2>&1 | tail -15
```
Expected: PASS.

- [ ] **Step 6: Extend the mock backend**

In `src/dev/mockBackend.ts`, after the `SUMMARY` definition add a commit fixture mapping each commit to a subset of the fixture's files:

```ts
const COMMITS = [
  { oid: "e4f1a2b0000000000000000000000000000000aa", shortOid: "e4f1a2b", subject: "wire login form into the page", author: "Dario", time: 1782700000 },
  { oid: "c9a30d40000000000000000000000000000000bb", shortOid: "c9a30d4", subject: "add session store", author: "Dario", time: 1782600000 },
  { oid: "a1b2c3d0000000000000000000000000000000cc", shortOid: "a1b2c3d", subject: "add auth guard to protected routes", author: "Dario", time: 1782500000 },
];
const COMMIT_FILES: Record<string, string[]> = {
  e4f1a2b0000000000000000000000000000000aa: ["src/auth/login.ts"],
  c9a30d40000000000000000000000000000000bb: ["src/auth/session.ts"],
  a1b2c3d0000000000000000000000000000000cc: ["src/api/routes.ts", "src/auth/session.ts"],
};
```

Then make `compute_diff` commit-aware and add `list_commits`. Replace the `compute_diff` case and add the new one:

```ts
      case "compute_diff": {
        const t = args?.target as { mode?: string; commit?: string } | undefined;
        if (t?.mode === "commit" && t.commit) {
          const set = new Set(COMMIT_FILES[t.commit] ?? []);
          return { ...ds.summary, files: ds.summary.files.filter((f) => set.has(f.path)) } as T;
        }
        return ds.summary as T;
      }
      case "list_commits":
        return COMMITS as T;
```

(`get_file_diff` needs no change — it returns the same file content regardless of mode, which is fine for the mock.)

- [ ] **Step 7: Typecheck + tests**

```bash
npx tsc --noEmit && pnpm test 2>&1 | tail -15
```
Expected: clean typecheck, all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/api.ts src/route.ts src/route.test.ts src/dev/mockBackend.ts
git commit -m "feat(api): add commit mode + listCommits across types, route, and mock"
```

---

## Task 6: Frontend — shadcn dropdown-menu primitive

**Files:**
- Create: `src/components/ui/dropdown-menu.tsx`

**Interfaces:**
- Produces: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent` — re-exports of the shadcn-styled radix primitives.

- [ ] **Step 1: Create the component**

Create `src/components/ui/dropdown-menu.tsx` (shadcn New-York style, adapted to the unified `radix-ui` import and `@/lib/utils`):

```tsx
import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { Check, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group
const DropdownMenuSub = DropdownMenuPrimitive.Sub

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = "DropdownMenuContent"

const itemCls =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item ref={ref} className={cn(itemCls, className)} {...props} />
))
DropdownMenuItem.displayName = "DropdownMenuItem"

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(itemCls, "data-[state=open]:bg-accent", className)} {...props}>
    {children}
    <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger"

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn("z-50 min-w-[12rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg", className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuSubContent.displayName = "DropdownMenuSubContent"

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
))
DropdownMenuSeparator.displayName = "DropdownMenuSeparator"

const DropdownMenuCheck = ({ checked }: { checked: boolean }) => (
  <Check className={cn("size-3.5 shrink-0", checked ? "opacity-100" : "opacity-0")} />
)

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuGroup, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger,
  DropdownMenuSubContent, DropdownMenuCheck,
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
npx tsc --noEmit 2>&1 | tail -10
```
Expected: clean. (`bg-popover`/`text-popover-foreground` exist in `index.css`; if tsc/build flags a missing token, fall back to `bg-card`/`text-card-foreground`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dropdown-menu.tsx
git commit -m "feat(ui): add shadcn dropdown-menu primitive with submenu support"
```

---

## Task 7: Frontend — commit mode in the Workspace (control, stepper, view, comments)

**Files:**
- Modify: `src/workspace/Workspace.tsx`
- Modify: `src/review/useReview.ts` (`addComment` gains an optional `commit`)
- Test: `src/workspace/Workspace.test.tsx`

**Interfaces:**
- Consumes: `api.listCommits`, `DropdownMenu*`, `CommitMeta`, `Target.commit`, `Comment.commit`.
- Produces: commit-mode overlay driven by `commitOid` state; `addComment(scope, anchor, body, commit?)`.

**Model (read before editing):** `diffMode` stays one of the four canonical scopes. A new `commitOid: string | null` is the overlay — when set, the diff pane renders that commit's isolated diff while the persisted review keeps its canonical mode. `viewTarget`/`viewSummary`/`viewComments` select what the panes see. New comments are stamped with `commitOid`.

- [ ] **Step 1: Add the `commit` param to `addComment`**

In `src/review/useReview.ts`, change the signature and object:

```ts
  const addComment = useCallback((scope: CommentScope, anchor: Anchor | null, body: string, commit?: string | null) => {
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomUUID(),
      scope,
      anchor: anchor ?? null,
      body,
      stale: false,
      resolved: false,
      commit: commit ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    mutate((r) => ({ ...r, comments: [...r.comments, comment] }), body.trim() === "" ? "none" : "now");
    return comment.id;
  }, [mutate]);
```

- [ ] **Step 2: Add commit state + data loading to Workspace**

In `src/workspace/Workspace.tsx`, add imports:

```ts
import type { Anchor, Comment, CommitMeta, DiffMode, DiffSummary, Review, ReviewSession, Target } from "../types";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuCheck } from "@/components/ui/dropdown-menu";
import { ChevronLeft, ChevronRight } from "lucide-react";
```

Add state (near the other `useState` lines, after `diffMode`):

```ts
  const [commitOid, setCommitOid] = useState<string | null>(target.commit ?? null);
  const [commits, setCommits] = useState<CommitMeta[]>([]);
  const [commitSummary, setCommitSummary] = useState<DiffSummary | null>(null);
```

Load the commit list whenever a review opens/refreshes. Add an effect after the bootstrap effect:

```ts
  // The branch's commits power the "Commit ▸" submenu + the stepper. Reloaded on
  // open/refresh so new commits appear. Best-effort: failure just empties the menu.
  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    void api.listCommits(review.target).then(
      (cs) => { if (!cancelled) setCommits(cs); },
      () => { if (!cancelled) setCommits([]); },
    );
    return () => { cancelled = true; };
  }, [review?.target.repoPath, review?.target.base, review?.snapshot.headOid]);
```

Load the commit's isolated diff when pinned. Add another effect:

```ts
  // Commit mode is a display overlay: fetch the pinned commit's isolated diff
  // without touching the persisted review (so untagged comments never re-anchor
  // against a single commit). Stepping re-fires via commitOid.
  useEffect(() => {
    if (!review || !commitOid) { setCommitSummary(null); return; }
    let cancelled = false;
    const vt: Target = { ...review.target, mode: "commit", commit: commitOid };
    void api.computeDiff(vt).then(
      (s) => { if (!cancelled) setCommitSummary(s); },
      (e) => { if (!cancelled) setError(String(e)); },
    );
    return () => { cancelled = true; };
  }, [commitOid, review?.target.repoPath, review?.target.base]);
```

- [ ] **Step 3: Derive the view target/summary/comments**

Add near `orderedFiles` (replace the existing `const orderedFiles = …` and `comments`/count derivations):

```ts
  const inCommitMode = commitOid != null;
  const viewTarget: Target = inCommitMode
    ? { ...(review?.target as Target), mode: "commit", commit: commitOid! }
    : (review?.target as Target);
  const viewSummary = inCommitMode ? commitSummary : summary;
  const allComments = review?.comments ?? [];
  // Each mode-context shows its own comments: the current commit's in commit mode,
  // the untagged ones otherwise. The index + Copy still see everything.
  const comments = inCommitMode
    ? allComments.filter((c) => c.commit === commitOid)
    : allComments.filter((c) => !c.commit);
  const commentCount = allComments.filter((c) => c.scope !== "general").length;
  const orderedFiles = flattenTreeFiles(viewSummary?.files ?? []);
  const commitIndex = inCommitMode ? commits.findIndex((c) => c.oid === commitOid) : -1;
```

`commentCountsByFile` should use the visible `comments` (already does — it reads `comments`). Leave it.

- [ ] **Step 4: Add the stepper handlers + keyboard shortcuts**

Add handlers (near the other `useCallback`s):

```ts
  const stepCommit = useCallback((delta: 1 | -1) => {
    setCommits((cs) => {
      setCommitOid((oid) => {
        const i = cs.findIndex((c) => c.oid === oid);
        const next = cs[i + delta];
        return next ? next.oid : oid;
      });
      return cs;
    });
  }, []);
  const pickCommit = useCallback((oid: string) => {
    setCommitOid(oid);
    syncCommitParam(oid);
  }, []);
  const exitCommitMode = useCallback((mode: DiffMode) => {
    setCommitOid(null);
    syncCommitParam(null);
    setDiffMode(mode);
    syncModeParam(mode);
  }, []);
```

Add a URL sync helper beside `syncModeParam` (top of file):

```ts
function syncCommitParam(oid: string | null) {
  const u = new URL(window.location.href);
  if (oid) u.searchParams.set("commit", oid);
  else u.searchParams.delete("commit");
  window.history.replaceState(null, "", u);
}
```

Extend the existing keydown effect (the one handling ⌘R/⌘⇧C) with `[`/`]` stepping when in commit mode. Inside `onKey`, add before the closing brace:

```ts
      else if (commitOid && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        stepCommit(e.key === "]" ? 1 : -1);
      }
```

Add `commitOid` and `stepCommit` to that effect's dependency array.

- [ ] **Step 5: Replace the `<select>` with the dropdown-menu + stepper**

Replace the `<div className="relative ml-1">…</select>…</div>` block (the diff-mode select, ~lines 325-337) with:

```tsx
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Diff mode"
                className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-muted/40 pl-2.5 pr-2 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus:bg-background"
              >
                {inCommitMode
                  ? <>Commit <span className="font-mono font-normal text-muted-foreground">{commits[commitIndex]?.shortOid ?? "…"}</span></>
                  : (MODES.find((m) => m.id === diffMode)?.label ?? diffMode)}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {MODES.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => exitCommitMode(m.id)}>
                    <DropdownMenuCheck checked={!inCommitMode && diffMode === m.id} />
                    {m.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={commits.length === 0}>
                    <DropdownMenuCheck checked={inCommitMode} />
                    Commit
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {commits.map((c) => (
                      <DropdownMenuItem key={c.oid} onSelect={() => pickCommit(c.oid)} className="gap-2.5">
                        <span className="font-mono text-muted-foreground">{c.shortOid}</span>
                        <span className="min-w-0 truncate">{c.subject}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            {inCommitMode && (
              <div className="ml-1 flex items-center gap-1.5" data-testid="commit-stepper">
                <div className="flex gap-0.5 rounded-md bg-muted/70 p-0.5">
                  <button type="button" aria-label="Previous commit" title="Previous commit ([)" disabled={commitIndex <= 0}
                    onClick={() => stepCommit(-1)}
                    className="grid size-6 place-items-center rounded-[5px] bg-card text-foreground shadow-sm disabled:opacity-40 disabled:shadow-none">
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <button type="button" aria-label="Next commit" title="Next commit (])" disabled={commitIndex < 0 || commitIndex >= commits.length - 1}
                    onClick={() => stepCommit(1)}
                    className="grid size-6 place-items-center rounded-[5px] bg-card text-foreground shadow-sm disabled:opacity-40 disabled:shadow-none">
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
                <span className="font-mono tabular-nums text-[11px] text-muted-foreground">{commitIndex + 1} / {commits.length}</span>
              </div>
            )}
```

- [ ] **Step 6: Point the panes at the view + tag new comments**

Update the children props. In `<VirtualDiffPane … target={review.target}>` change to `target={viewTarget}`. The `files={orderedFiles}` and `comments={comments}` already use the derived view values from Step 3. Update the comment-add callbacks to stamp the commit:

```ts
  const onAddComment = useCallback(
    (anchor: Anchor, body: string) => addComment(anchor.endLine != null ? "range" : "line", anchor, body, commitOid),
    [addComment, commitOid],
  );
  const onAddFileComment = useCallback(
    (file: string, body: string) =>
      addComment("file", { file, side: "new", startLine: null, endLine: null, snippet: null }, body, commitOid),
    [addComment, commitOid],
  );
```

Pass **all** comments to the index so nothing is hidden there:

```tsx
            <CommentIndex
              open={indexOpen}
              onOpenChange={setIndexOpen}
              comments={allComments}
              onJump={onJump}
            />
```

The `NothingToReview` `modeLabel` prop: pass `inCommitMode ? "this commit" : (MODES.find((m) => m.id === diffMode)?.label ?? diffMode)`.

- [ ] **Step 7: Write the failing Workspace tests**

Add to `src/workspace/Workspace.test.tsx` (it already renders Workspace against the mock; mirror the existing setup). Add tests that the submenu enters commit mode and the stepper shows:

```tsx
it("enters commit mode from the Commit submenu and shows the stepper", async () => {
  renderWorkspace(); // existing helper that mounts Workspace with the mock IPC
  const user = userEvent.setup();
  await screen.findByLabelText("Diff mode");
  await user.click(screen.getByLabelText("Diff mode"));
  await user.click(await screen.findByText("Commit"));
  await user.click(await screen.findByText("add session store"));
  expect(await screen.findByTestId("commit-stepper")).toBeInTheDocument();
  expect(screen.getByText(/\d+ \/ \d+/)).toBeInTheDocument();
});
```

(If `Workspace.test.tsx` has no `renderWorkspace`/`userEvent` helper, follow the file's existing pattern for mounting + interaction; keep the assertion on `commit-stepper` + the `N / M` counter.)

- [ ] **Step 8: Run the FE suite + typecheck**

```bash
npx tsc --noEmit && pnpm test 2>&1 | tail -20
```
Expected: clean typecheck, all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/workspace/Workspace.tsx src/review/useReview.ts src/workspace/Workspace.test.tsx
git commit -m "feat(workspace): review commit-by-commit via a Commit submenu + stepper"
```

---

## Task 8: Verification — full suite + dev:mock manual pass

**Files:** none (verification + any fixups surfaced).

- [ ] **Step 1: Full backend + frontend suites**

```bash
cd src-tauri && cargo test 2>&1 | tail -8 && cd .. && npx tsc --noEmit && pnpm test 2>&1 | tail -8
```
Expected: all green.

- [ ] **Step 2: dev:mock visual pass**

```bash
pnpm dev:mock
```
Open `http://localhost:5599/?view=review&repo=demo`. Verify with the preview MCP / agent-browser:
- The mode dropdown opens; "Commit ▸" reveals the three fixture commits.
- Selecting one shows the isolated file subset (per `COMMIT_FILES`) and the stepper `N / M`; the trigger reads `Commit <shortOid>`.
- Prev/next buttons step and disable at the ends; `[`/`]` keys step too.
- A new comment added in commit mode stays visible in that commit and disappears when you switch to a canonical mode; the comment index still lists it.
- Toggle theme (`localStorage["delta.theme"]`) light/dark and layout unified/split — the dropdown, submenu, and stepper read correctly in both.

Note: the headless preview freezes `requestAnimationFrame`; reason about scroll-driven state rather than exercising it.

- [ ] **Step 3: Fix anything surfaced, re-run Step 1, then commit (if changes)**

```bash
git add -A && git commit -m "fix(workspace): address commit-mode review issues found in dev:mock"
```

---

## Self-Review

**Spec coverage:**
- Lens/isolated/tagged/Codex-control → Tasks 1,2,3,6,7. ✓
- `DiffMode::Commit` + `Target.commit` + root/merge handling → Task 1 (root covered; merge uses `parent(0)`, matching spec v1). ✓
- `list_commits` (merge-base..HEAD, newest-first) → Task 2. ✓
- `Comment.commit` + reconcile freeze (stale iff oid gone) → Task 3. ✓
- Export annotation → Task 4. ✓
- types/api/route/mock all three layers → Task 5. ✓
- shadcn dropdown-menu (radix-ui unified) → Task 6. ✓
- View-vs-canonical invariant, stepper + `[`/`]`, trigger label, URL, comment tag/filter → Task 7. ✓
- Empty range → submenu `disabled` (Task 7 Step 5). ✓
- Verification via dev:mock, light/dark, unified/split → Task 8. ✓

**Placeholder scan:** none — every code/test step has concrete content; compiler-driven literal fixes (Tasks 1, 3) name the exact command + edit.

**Type consistency:** `CommitMeta` fields (`oid`/`shortOid`/`subject`/`author`/`time`) match across Rust (`#[serde(rename_all="camelCase")]`), `types.ts`, and the mock. `Target.commit`/`Comment.commit` consistent across layers. `addComment` 4-arg signature matches its two call sites. `viewTarget.mode = "commit"` matches the backend `DiffMode::Commit`.

**Deferred (per spec, non-blocking):** cumulative diff, merge-parent selection, cross-commit index→switch navigation polish, "+N on other commits" hint.

# Launch Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace delta's import-first Home and the repo→worktree command-palette funnel with one shared `ReviewPicker` — a flat, searchable list of recent reviews + current worktrees of known repos + an "Add a repo…" action — backed by a new live `list_picker` command.

**Architecture:** Backend gains a `list_picker` command that loads the persisted registry, enumerates worktrees **live** per known repo, drops worktrees already covered by a saved review, and returns `{ recents, worktrees, home }`. Frontend gains a `ReviewPicker` component mounted in two frames: the Home window and the ⌘K overlay. The repo/worktree palette pages and the import hero are deleted.

**Tech Stack:** Rust (Tauri 2, git2), React 19 + TypeScript, Tailwind v4, Vitest (happy-dom), `cargo test`.

## Global Constraints

- **Three-layer rule:** any Tauri command change must update `src-tauri/src/commands.rs`, `src/api.ts`, AND `src/dev/mockBackend.ts` together, or mock mode breaks.
- **Conventional Commits** for every commit.
- Run `npx tsc --noEmit` and `pnpm test` (and `cargo test` for Rust) before each commit.
- Styling: Tailwind v4 oklch tokens (`--primary`, `--muted`, `--accent`, etc.) — no hardcoded colors.
- The command palette is the documented exception to centered modals (it stays top-anchored at `pt-[16vh]`). Home content is centered.
- UI validation via `pnpm dev:mock` (port 5599) + preview MCP; verify light AND dark.

---

## File Structure

- `src-tauri/src/commands.rs` — add `PickerData`, `PickerWorktree`, `worktree_has_review`, `list_picker_impl`, `list_picker` command.
- `src-tauri/src/lib.rs` — register `commands::list_picker` in `generate_handler!`.
- `src/types.ts` — add `PickerWorktree`, `PickerData`.
- `src/api.ts` — add `listPicker`.
- `src/dev/mockBackend.ts` — add `list_picker` case + fixture.
- `src/picker/fuzzy.ts` — add `rankWorktrees`.
- `src/picker/ReviewPicker.tsx` — NEW shared component (search + grouped list + keyboard + actions).
- `src/picker/CommandPalette.tsx` — collapse to a thin overlay wrapper around `ReviewPicker`.
- `src/Home.tsx` — replace import hero with `ReviewPicker` + slim brand + empty state.
- Tests: `src-tauri/src/commands.rs` (inline), `src/picker/fuzzy.test.ts`, `src/picker/ReviewPicker.test.tsx`.

---

## Task 1: Backend — `worktree_has_review` de-dup predicate

**Files:**
- Modify: `src-tauri/src/commands.rs` (add helper near the registry-sync helpers ~line 77; add test in the `#[cfg(test)]` module)

**Interfaces:**
- Produces: `pub fn worktree_has_review(w: &WorktreeEntry, repo_name: &str, recents: &[ReviewEntry]) -> bool`

- [ ] **Step 1: Write the failing test** (in the `mod tests` block of `commands.rs`)

```rust
#[test]
fn worktree_has_review_matches_by_path_or_repo_and_branch() {
    use crate::registry::model::{ReviewEntry, WorktreeEntry};
    let recents = vec![ReviewEntry {
        id: "x".into(),
        repo_name: "demo".into(),
        target: Target { repo_path: "/r/demo".into(), worktree: Some("feat/a".into()), mode: DiffMode::AllChanges, base: None },
        last_opened_at: "t".into(),
        comment_count: 0, stale_count: 0, viewed_count: 0, file_count: 1,
    }];
    let wt = |path: &str, branch: &str| WorktreeEntry { path: path.into(), branch: branch.into(), is_main: false, last_commit_at: None, dirty: false };
    // same path → covered
    assert!(worktree_has_review(&wt("/r/demo", "feat/a"), "demo", &recents));
    // same repo + branch, different path (linked worktree) → covered
    assert!(worktree_has_review(&wt("/r/demo-a", "feat/a"), "demo", &recents));
    // different branch → not covered
    assert!(!worktree_has_review(&wt("/r/demo-b", "feat/b"), "demo", &recents));
    // different repo → not covered
    assert!(!worktree_has_review(&wt("/r/demo", "feat/a"), "other", &recents));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib worktree_has_review`
Expected: FAIL — `cannot find function worktree_has_review`.

- [ ] **Step 3: Write minimal implementation** (add above `sync_registry_after_open`)

```rust
use crate::registry::model::WorktreeEntry;

/// True when a recent review already covers this worktree (so the picker lists it
/// under "recent", not "other worktrees"). Matches by worktree path, or by repo
/// name + branch (linked worktrees resolve to a different path than the review's).
pub fn worktree_has_review(w: &WorktreeEntry, repo_name: &str, recents: &[ReviewEntry]) -> bool {
    recents.iter().any(|r| {
        r.target.repo_path == w.path
            || (r.repo_name == repo_name && r.target.worktree.as_deref() == Some(w.branch.as_str()))
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib worktree_has_review`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(picker): add worktree_has_review de-dup predicate"
```

---

## Task 2: Backend — `list_picker` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `PickerWorktree`, `PickerData`, `list_picker_impl`, `#[tauri::command] list_picker`; test in `mod tests`)
- Modify: `src-tauri/src/lib.rs:48` (register command)

**Interfaces:**
- Consumes: `worktree_has_review` (Task 1); `launch::list_worktrees(&str) -> Result<Vec<WorktreeEntry>, String>`; `RegistryStore` trait (`reg_store(&app)`); `reg.repos`, `reg.reviews`.
- Produces:
  - `PickerData { recents: Vec<ReviewEntry>, worktrees: Vec<PickerWorktree>, home: Option<String> }`
  - `PickerWorktree { #[serde(flatten)] worktree: WorktreeEntry, repo_name: String, repo_id: String }`
  - `pub fn list_picker_impl(reg_store: &dyn RegistryStore, home: Option<String>) -> Result<PickerData, String>`
  - `#[tauri::command] pub fn list_picker(app: tauri::AppHandle) -> Result<PickerData, String>`

- [ ] **Step 1: Write the failing test** (uses the existing `stores()` test helper + `git::test_support`)

```rust
#[test]
fn list_picker_returns_recents_and_unreviewed_worktrees() {
    use crate::git::test_support::{add_worktree, repo_with_commit};
    let (dir, repo) = repo_with_commit();              // main worktree on "main"
    add_worktree(&repo, dir.path(), "demo-feat", "feat/a"); // linked worktree "feat/a"
    let root = dir.path().to_str().unwrap().to_string();

    let store_dir = tempfile::TempDir::new().unwrap();
    let (_storage, reg_store) = stores(store_dir.path());
    // Register the repo (as opening a worktree would) and a review on "main".
    let mut reg = reg_store.load().unwrap();
    reg.upsert_repo(repo_entry(&root).unwrap());
    reg.upsert_review(ReviewEntry {
        id: "rev1".into(), repo_name: repo_name_from_path(&root),
        target: Target { repo_path: root.clone(), worktree: Some("main".into()), mode: DiffMode::AllChanges, base: None },
        last_opened_at: "t".into(), comment_count: 0, stale_count: 0, viewed_count: 0, file_count: 1,
    });
    reg_store.save(&reg).unwrap();

    let data = list_picker_impl(&reg_store, Some("/Users/me".into())).unwrap();
    assert_eq!(data.recents.len(), 1);
    // "main" is covered by a review → only "feat/a" appears under other worktrees.
    let branches: Vec<&str> = data.worktrees.iter().map(|w| w.worktree.branch.as_str()).collect();
    assert_eq!(branches, vec!["feat/a"]);
    assert_eq!(data.worktrees[0].repo_name, repo_name_from_path(&root));
    assert_eq!(data.home.as_deref(), Some("/Users/me"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib list_picker_returns_recents`
Expected: FAIL — `cannot find function list_picker_impl` / `PickerData`.

- [ ] **Step 3: Write minimal implementation**

Add types + impl near `list_registry` in `commands.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerWorktree {
    #[serde(flatten)]
    pub worktree: WorktreeEntry,
    pub repo_name: String,
    pub repo_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerData {
    pub recents: Vec<ReviewEntry>,
    pub worktrees: Vec<PickerWorktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

/// Recents + the live, currently-checked-out worktrees of every known repo, with
/// worktrees already covered by a review removed (they show under recents).
pub fn list_picker_impl(reg_store: &dyn RegistryStore, home: Option<String>) -> Result<PickerData, String> {
    let reg = reg_store.load()?;
    let recents = reg.reviews.clone();
    let mut worktrees = Vec::new();
    for repo in &reg.repos {
        // Best-effort: a repo whose worktrees can't be listed (moved/deleted) is skipped.
        let wts = crate::launch::list_worktrees(&repo.root).unwrap_or_default();
        for w in wts {
            if worktree_has_review(&w, &repo.name, &recents) {
                continue;
            }
            worktrees.push(PickerWorktree { worktree: w, repo_name: repo.name.clone(), repo_id: repo.id.clone() });
        }
    }
    Ok(PickerData { recents, worktrees, home })
}

#[tauri::command]
pub fn list_picker(app: tauri::AppHandle) -> Result<PickerData, String> {
    let home = std::env::var("HOME").ok();
    list_picker_impl(&reg_store(&app)?, home)
}
```

Ensure `repo_entry` and `repo_name_from_path` are imported in the test scope (they're already used in `commands.rs`).

- [ ] **Step 4: Register the command** in `src-tauri/src/lib.rs` (after `commands::list_registry,` at line ~43):

```rust
            commands::list_picker,
```

- [ ] **Step 5: Run test + full suite**

Run: `cargo test --lib`
Expected: PASS (new test green, all prior tests green).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(picker): add list_picker command (recents + live known-repo worktrees)"
```

---

## Task 3: Frontend — types, api, mock for `list_picker`

**Files:**
- Modify: `src/types.ts` (add `PickerWorktree`, `PickerData`)
- Modify: `src/api.ts` (add `listPicker`)
- Modify: `src/dev/mockBackend.ts` (add `list_picker` case + fixture)

**Interfaces:**
- Produces (TS):
  - `PickerWorktree { path: string; branch: string; isMain: boolean; lastCommitAt?: string | null; dirty?: boolean; repoName: string; repoId: string }`
  - `PickerData { recents: ReviewEntry[]; worktrees: PickerWorktree[]; home?: string | null }`
  - `api.listPicker(): Promise<PickerData>`

- [ ] **Step 1: Add types** to `src/types.ts` (after `Registry`):

```ts
export interface PickerWorktree {
  path: string;
  branch: string;
  isMain: boolean;
  lastCommitAt?: string | null;
  dirty?: boolean;
  repoName: string;
  repoId: string;
}

export interface PickerData {
  recents: ReviewEntry[];
  worktrees: PickerWorktree[];
  home?: string | null;
}
```

- [ ] **Step 2: Add the api method** to `src/api.ts` (import `PickerData`; add to the `api` object):

```ts
  listPicker: (): Promise<PickerData> => invokeImpl("list_picker"),
```

- [ ] **Step 3: Add the mock** to `src/dev/mockBackend.ts` `switch` (import `PickerData` type; derive from `REGISTRY` + the existing `list_worktrees` fixture, de-duping "feat/auth" and "main" which have reviews):

```ts
      case "list_picker": {
        const data: PickerData = {
          home: REGISTRY.home,
          recents: REGISTRY.reviews,
          // demo's reviewed worktrees are feat/auth + main; leave spike + imported visible.
          worktrees: [
            { path: "/Users/me/projects/demo-spike", branch: "spike/new-idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
          ],
        };
        return structuredClone(data) as T;
      }
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/api.ts src/dev/mockBackend.ts
git commit -m "feat(picker): add PickerData types, api.listPicker, mock"
```

---

## Task 4: Frontend — `rankWorktrees`

**Files:**
- Modify: `src/picker/fuzzy.ts` (add `rankWorktrees`)
- Modify: `src/picker/fuzzy.test.ts` (add test)

**Interfaces:**
- Consumes: `fuzzyMatch` (exists), `PickerWorktree` (Task 3)
- Produces: `export function rankWorktrees(worktrees: PickerWorktree[], query: string): PickerWorktree[]`

- [ ] **Step 1: Write the failing test** in `src/picker/fuzzy.test.ts`:

```ts
import { rankWorktrees } from "./fuzzy";
import type { PickerWorktree } from "../types";

const wt = (branch: string, repoName: string, lastCommitAt?: string): PickerWorktree =>
  ({ path: `/r/${branch}`, branch, isMain: false, lastCommitAt, dirty: false, repoName, repoId: "r1" });

test("rankWorktrees filters by branch/repo and sorts recents first when unfiltered", () => {
  const list = [wt("feat/a", "demo", "2026-06-20T00:00:00Z"), wt("feat/b", "demo", "2026-06-26T00:00:00Z")];
  // empty query → newest lastCommitAt first
  expect(rankWorktrees(list, "").map((w) => w.branch)).toEqual(["feat/b", "feat/a"]);
  // query narrows to a branch
  expect(rankWorktrees(list, "feat/a").map((w) => w.branch)).toEqual(["feat/a"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test fuzzy`
Expected: FAIL — `rankWorktrees is not a function`.

- [ ] **Step 3: Write minimal implementation** in `src/picker/fuzzy.ts`:

```ts
import type { PickerWorktree, ReviewEntry } from "../types";

/** Filter + rank worktrees against a query (branch + repo name haystack). */
export function rankWorktrees(worktrees: PickerWorktree[], query: string): PickerWorktree[] {
  const scored: { w: PickerWorktree; score: number }[] = [];
  for (const w of worktrees) {
    const score = fuzzyMatch(query, `${w.branch} ${w.repoName}`);
    if (score !== null) scored.push({ w, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.w.lastCommitAt ?? "").localeCompare(a.w.lastCommitAt ?? ""));
  return scored.map((x) => x.w);
}
```

(Update the existing `import type { ReviewEntry } from "../types";` line to also import `PickerWorktree`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test fuzzy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/picker/fuzzy.ts src/picker/fuzzy.test.ts
git commit -m "feat(picker): add rankWorktrees ranking"
```

---

## Task 5: Frontend — `ReviewPicker` component

**Files:**
- Create: `src/picker/ReviewPicker.tsx`
- Create: `src/picker/ReviewPicker.test.tsx`

**Interfaces:**
- Consumes: `api.listPicker`, `rankReviews`, `rankWorktrees`, `PickerData`, `ReviewEntry`, `PickerWorktree`, `Target`.
- Produces:
```ts
export interface ReviewPickerProps {
  /** Current review's target, excluded from the list (⌘K frame). Omit on Home. */
  current?: Target;
  /** Frame chrome: "home" (centered window) vs "palette" (overlay). Affects only the wrapper, not the list. */
  onOpenReview: (r: ReviewEntry) => void;       // open existing review (restores its target)
  onOpenWorktree: (w: PickerWorktree) => void;  // open a worktree (all-changes default)
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => void;
}
export function ReviewPicker(props: ReviewPickerProps): JSX.Element
```

ReviewPicker owns: registry fetch (`api.listPicker` on mount), search query, selection index, keyboard nav (↑↓ move across the flat sequence of [recents…, worktrees…, addRepo], ↵ activate, ⌘⌫ delete a recent). It renders two labeled groups ("Recent", "Other worktrees") and a pinned "Add a repo…" row. It filters recents via `rankReviews` (excluding `current`) and worktrees via `rankWorktrees`.

- [ ] **Step 1: Write the failing component test** `src/picker/ReviewPicker.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPicker } from "./ReviewPicker";
import { __setInvokeForDev } from "../api";
import type { PickerData } from "../types";

const DATA: PickerData = {
  home: "/Users/me",
  recents: [{ id: "rev1", repoName: "demo", target: { repoPath: "/r/demo", worktree: "feat/auth", mode: "all-changes" }, lastOpenedAt: "2026-06-26T10:00:00Z", commentCount: 3, staleCount: 1, viewedCount: 2, fileCount: 7 }],
  worktrees: [{ path: "/r/demo-spike", branch: "spike/idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" }],
};

function mock(data: PickerData) {
  __setInvokeForDev(async <T,>(cmd: string): Promise<T> => {
    if (cmd === "list_picker") return structuredClone(data) as T;
    throw new Error(`unexpected ${cmd}`);
  });
}

test("lists recents and other worktrees, and opens a worktree on click", async () => {
  mock(DATA);
  const onOpenWorktree = vi.fn();
  render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={onOpenWorktree} onAddRepo={() => {}} onDeleteReview={() => {}} />);
  await waitFor(() => screen.getByText("feat/auth"));
  expect(screen.getByText("spike/idea")).toBeInTheDocument();
  await userEvent.click(screen.getByText("spike/idea"));
  expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: "spike/idea" }));
});

test("filtering by query narrows the list", async () => {
  mock(DATA);
  render(<ReviewPicker onOpenReview={() => {}} onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={() => {}} />);
  await waitFor(() => screen.getByText("feat/auth"));
  await userEvent.type(screen.getByRole("textbox"), "spike");
  expect(screen.queryByText("feat/auth")).not.toBeInTheDocument();
  expect(screen.getByText("spike/idea")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ReviewPicker`
Expected: FAIL — cannot resolve `./ReviewPicker`.

- [ ] **Step 3: Implement `ReviewPicker.tsx`.** Adapt the existing `CommandPalette` list/keyboard/row code (it already has fuzzy ranking, keyboard nav, scroll-into-view, delete, the scroll-induced-mousemove guard). Build a flat `items` array in order: filtered recents (each `onActivate: onOpenReview`, `onDelete: onDeleteReview`), then filtered worktrees (`onActivate: onOpenWorktree`), then a single "Add a repo…" item (`onActivate: onAddRepo`). Render group labels "RECENT" before the recents block and "OTHER WORKTREES" before the worktrees block (omit a label if its block is empty). Reuse the row markup from `CommandPalette` (leading `GitBranch` icon, primary = branch, secondary = repo name, meta = comment/stale counts + relTime for recents; dirty marker + relTime for worktrees). Exclude `current` from recents using the same predicate `CommandPalette` uses today (repoPath + mode + base match). Use oklch tokens already in `CommandPalette`.

  Key structure:

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { rankReviews, rankWorktrees } from "./fuzzy";
import { GitBranch, MessageSquare, TriangleAlert, FolderPlus } from "lucide-react";
import type { PickerData, PickerWorktree, ReviewEntry, Target } from "../types";

export interface ReviewPickerProps {
  current?: Target;
  onOpenReview: (r: ReviewEntry) => void;
  onOpenWorktree: (w: PickerWorktree) => void;
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => void;
}

export function ReviewPicker({ current, onOpenReview, onOpenWorktree, onAddRepo, onDeleteReview }: ReviewPickerProps) {
  const [data, setData] = useState<PickerData | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // load
  useEffect(() => { void (async () => setData(await api.listPicker()))(); }, []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const isCurrent = (r: ReviewEntry) =>
    current != null && r.target.repoPath === current.repoPath &&
    r.target.mode === current.mode && (r.target.base ?? null) === (current.base ?? null);

  const recents = data ? rankReviews(data.recents.filter((r) => !isCurrent(r)), query) : [];
  const worktrees = data ? rankWorktrees(data.worktrees, query) : [];
  // Flat activswitch sequence for keyboard nav: recents, worktrees, addRepo
  // (build an items[] with {kind, onActivate, onDelete?} as in CommandPalette)
  // ...render input + "RECENT" group + "OTHER WORKTREES" group + "Add a repo…"
}
```

  (Mirror `CommandPalette`'s `onKey`, `clampedSel`, `scrollIntoView`, and `onItemMouseMove` logic verbatim, over the combined `items` array.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test ReviewPicker`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/picker/ReviewPicker.tsx src/picker/ReviewPicker.test.tsx
git commit -m "feat(picker): add shared ReviewPicker component"
```

---

## Task 6: Mount `ReviewPicker` in the ⌘K palette (delete the funnel)

**Files:**
- Modify: `src/picker/CommandPalette.tsx` (collapse to overlay wrapper)
- Modify: `src/picker/CommandPalette.test.tsx` (update to the flat picker; drop funnel-page assertions)

**Interfaces:**
- Consumes: `ReviewPicker` (Task 5). `CommandPalette` keeps its props `{ onClose: () => void; current?: Target }`.

- [ ] **Step 1: Update the test** `CommandPalette.test.tsx` — replace any "pick a repository / pick a worktree" page assertions with: opening a recent calls `open_target`/closes; the overlay renders the picker. (Read the current test first; keep the still-valid cases, delete funnel-specific ones.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test CommandPalette`
Expected: FAIL (old funnel assertions gone / new structure not yet wired).

- [ ] **Step 3: Rewrite `CommandPalette.tsx`** as the top-anchored overlay (keep the `pt-[16vh]` backdrop, ⌘K mount, esc-to-close, click-outside-to-close) wrapping `<ReviewPicker>`:

```tsx
import { ReviewPicker } from "./ReviewPicker";
import { api } from "../api";
import type { PickerWorktree, ReviewEntry, Target } from "../types";

export function CommandPalette({ onClose, current }: { onClose: () => void; current?: Target }) {
  const openReview = (r: ReviewEntry) => { void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined); onClose(); };
  const openWorktree = (w: PickerWorktree) => { void api.openTarget(w.path, "all-changes"); onClose(); };
  const addRepo = async () => {
    const repo = await api.importRepo();
    if (repo) { const wts = await api.listWorktrees(repo.root); const main = wts.find((w) => w.isMain) ?? wts[0]; if (main) void api.openTarget(main.path, "all-changes"); onClose(); }
  };
  const deleteReview = async (r: ReviewEntry) => { if (confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) { await api.deleteReview(r.id); /* ReviewPicker refetches on next open */ } };
  return (
    <div data-testid="command-palette" className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-[16vh] ..." onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[64vh] w-[40rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover ..." onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
        <ReviewPicker current={current} onOpenReview={openReview} onOpenWorktree={openWorktree} onAddRepo={addRepo} onDeleteReview={deleteReview} />
      </div>
    </div>
  );
}
```

Delete `Page`, `chooseRepo`, `chooseWorktree`, worktree state, `doImport` multi-step, the repo/worktree page branches.

- [ ] **Step 4: Run tests**

Run: `pnpm test CommandPalette ReviewPicker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/picker/CommandPalette.tsx src/picker/CommandPalette.test.tsx
git commit -m "refactor(picker): collapse CommandPalette to ReviewPicker overlay"
```

---

## Task 7: Mount `ReviewPicker` in Home (delete the import hero)

**Files:**
- Modify: `src/Home.tsx`

**Interfaces:**
- Consumes: `ReviewPicker` (Task 5). `Home` keeps `{ onOpenSettings?: () => void }`.

- [ ] **Step 1: Rewrite `Home.tsx`** — keep the borderless launcher chrome (drag strip, settings button top-right, brand mark Δ), but replace the import button + hand-rolled recents with a centered `<ReviewPicker>`. Empty state lives inside ReviewPicker (no repos/recents → show the "Add a repo…" row + hint "or run `delta` in a repo"). Actions:

```tsx
const openReview = (r: ReviewEntry) => void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
const openWorktree = (w: PickerWorktree) => void api.openTarget(w.path, "all-changes");
const addRepo = async () => { const repo = await api.importRepo(); if (repo) { const wts = await api.listWorktrees(repo.root); const main = wts.find((w) => w.isMain) ?? wts[0]; if (main) void api.openTarget(main.path, "all-changes"); } };
const deleteReview = async (r: ReviewEntry) => { if (confirm(...)) await api.deleteReview(r.id); };
```

Render `<ReviewPicker onOpenReview={openReview} onOpenWorktree={openWorktree} onAddRepo={addRepo} onDeleteReview={deleteReview} />` inside the centered `max-w-md` column. Drop `MAX_RECENT`, `rankReviews` import, the local recents list, and the `importRepo` hero handler (moved into `addRepo`).

- [ ] **Step 2: Verify build + tests**

Run: `npx tsc --noEmit && pnpm test`
Expected: no type errors; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/Home.tsx
git commit -m "refactor(picker): Home renders ReviewPicker (drop import hero)"
```

---

## Task 8: Empty state + integration verification

**Files:**
- Modify: `src/picker/ReviewPicker.tsx` (empty state) if not already handled in Task 5.

- [ ] **Step 1: Add empty-state test** in `ReviewPicker.test.tsx`: when `list_picker` returns `{ recents: [], worktrees: [] }`, the picker shows an "Add a repo…" affordance and a hint mentioning `delta`. Run, see it fail, implement the empty-state branch, run, pass.

- [ ] **Step 2: Full suite**

Run: `cargo test --lib && npx tsc --noEmit && pnpm test`
Expected: all green.

- [ ] **Step 3: Visual check (mock mode).** Start `pnpm dev:mock`, open the Home frame (`localhost:5599`) and a review with `?view=review&repo=demo` then ⌘K. Verify via preview MCP: Recent + Other-worktrees groups render, search filters, light AND dark both correct. (Headless preview freezes rAF; scroll-into-view is exercised by reasoning, not the harness.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(picker): empty state + verified Home/⌘K integration"
```

---

## Self-Review

**Spec coverage:**
- One picker, two frames → Tasks 5–7. ✓
- Recents + known-repo worktrees + add-repo → Tasks 2 (backend), 5 (render). ✓
- Known repos from launches → existing `sync_registry_after_open` (no task needed; noted). ✓
- De-dup by worktree → Task 1 + used in Task 2. ✓
- Live worktrees (`list_picker`, not `list_registry`) → Task 2. ✓
- Light Recent/Other grouping → Task 5. ✓
- Open recent restores target / open worktree = all-changes → Tasks 6–7. ✓
- Add-a-repo flow (open main if one) → Tasks 6–7. ✓
- After-last-close shows picker → falls out of Home rendering the picker (existing lifecycle); no code task. ✓
- Three-layer rule → Task 3. ✓
- No watching → nothing added. ✓

**Placeholder scan:** none — every code/test step has concrete content. Task 5's component body references "mirror CommandPalette's onKey/clamped/scrollIntoView verbatim," which is concrete (that code exists and is cited).

**Type consistency:** `PickerData`/`PickerWorktree` identical across Rust (Task 2, camelCase serde) and TS (Task 3). `worktree_has_review` signature consistent between Tasks 1–2. `api.listPicker` ↔ `list_picker` command name matches. `rankWorktrees` signature consistent between Tasks 4–5.

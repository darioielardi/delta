# Mode-as-view + native-feel polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make diff mode a per-window view setting (not part of review identity), add a persisted split/unified toggle, polish the files panel + file headers, and fix four native-feel issues (cold-start flash, reduced-motion, window-state, main-thread git, traffic-light position, mis-scrolling jumps).

**Architecture:** Drop `mode` from the review id hash so one review exists per (repo, worktree); mode becomes local window state that recomputes the diff in place via the existing reconcile path. Frontend changes thread a localStorage-backed layout preference and restructure the files panel / diff headers. Native fixes are config/plugin changes in the Tauri Rust layer plus a show-after-paint hook.

**Tech Stack:** Rust (Tauri v2, git2), React 19 + TypeScript, Tailwind v4, `@git-diff-view/react`, Vitest + Testing Library, `cargo test`.

## Global Constraints

- Frontend tests: `pnpm test` (vitest run); single file: `pnpm exec vitest run <path>`.
- Rust tests: `cd src-tauri && cargo test`.
- Mock UI run for visual checks: `pnpm dev:mock` (port 5599), then preview MCP. macOS has no tauri-driver; **native chrome (traffic lights, cold-start flash) is NOT visible in the browser mock** — verify those in a real `pnpm tauri dev` build / user confirmation.
- Keep diffs tightly scoped (user rule). Conventional Commits. Commit after each task.
- All work on a feature branch off `main` (created in Task 0), not `main` directly.
- Review id is `SHA-256(...)[..16 hex]`; ids must stay 16 lowercase hex (storage `is_valid_id`).
- "Start fresh" migration: never load pre-v2 review files; drop pre-v2 registry review entries; leave old files on disk.

---

### Task 0: Feature branch

- [ ] **Step 1: Create the branch**

```bash
cd /Users/dario.ielardi/projects/delta
git checkout -b feat/mode-as-view-native-polish
```

- [ ] **Step 2: Confirm clean baseline tests pass**

Run: `pnpm test && (cd src-tauri && cargo test)`
Expected: all green (records the pre-change baseline).

---

### Task 1: Drop `mode` from review identity

**Files:**
- Modify: `src-tauri/src/review/model.rs` (`review_id` signature + test)
- Modify: `src-tauri/src/commands.rs:35` (`open_review_impl` call site)
- Modify: `src-tauri/src/launch/mod.rs:131` (`open_target_window` call site)

**Interfaces:**
- Produces: `pub fn review_id(repo_path: &str, worktree: &str) -> String` (mode arg removed).

- [ ] **Step 1: Update the failing test** in `src-tauri/src/review/model.rs`

```rust
    #[test]
    fn review_id_is_stable_and_mode_independent() {
        let a = review_id("/Users/me/p", "main");
        let b = review_id("/Users/me/p", "main");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // worktree participates; mode is no longer part of the id (no arg).
        assert_ne!(a, review_id("/Users/me/p", "feat"));
    }
```

(Delete the old `review_id_is_stable_16_hex` test. The rewritten tests no longer use `DiffMode`, so remove `use crate::git::model::DiffMode;` from inside `mod tests`.)

- [ ] **Step 2: Run it — verify it fails to compile**

Run: `cd src-tauri && cargo test review_id`
Expected: compile error (arity mismatch) — proves the test targets the new signature.

- [ ] **Step 3: Change `review_id`** in `src-tauri/src/review/model.rs`

```rust
/// Stable review id: first 16 hex chars of SHA-256(repoPath \0 worktree).
/// Mode is intentionally excluded — one review per (repo, worktree).
pub fn review_id(repo_path: &str, worktree: &str) -> String {
    let mut h = Sha256::new();
    h.update(repo_path.as_bytes());
    h.update([0]);
    h.update(worktree.as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}
```

The file-head import is `use crate::git::model::{DiffMode, Target};` — `DiffMode` is now unused at module scope, so change it to `use crate::git::model::Target;`.

- [ ] **Step 4: Update `open_review_impl`** in `src-tauri/src/commands.rs` (line ~35)

```rust
    let id = review_id(&target.repo_path, &worktree);
```

- [ ] **Step 5: Update `open_target_window`** in `src-tauri/src/launch/mod.rs` (line ~131)

```rust
    let id = review_id(&canonical, &worktree);
```

- [ ] **Step 6: Run the suite**

Run: `cd src-tauri && cargo test`
Expected: PASS (all). Fix any other `review_id(` call sites the compiler flags.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(review): drop diff mode from review identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Start-fresh migration (registry v2 / review v2)

**Files:**
- Modify: `src-tauri/src/registry/model.rs` (`Registry::empty` version)
- Modify: `src-tauri/src/review/model.rs` (`Review::new` version)
- Modify: `src-tauri/src/storage/mod.rs` (`load` migration + `rebuild` skip + tests)

**Interfaces:**
- Consumes: `Registry { version, repos, reviews }`, `Review { version, .. }`.
- Produces: registry load yields `version == 2` with pre-v2 `reviews` dropped; `rebuild()` ignores review files with `version < 2`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/storage/mod.rs` (`mod tests`)

```rust
    #[test]
    fn registry_load_v1_drops_reviews_keeps_repos() {
        let dir = TempDir::new().unwrap();
        let reg_path = dir.path().join("registry.json");
        // A v1 registry with one repo and one (stale, per-mode) review entry.
        std::fs::write(&reg_path, r#"{"version":1,"repos":[{"id":"r1","root":"/p","name":"p","worktrees":[]}],"reviews":[{"id":"0123456789abcdef","repoName":"p","target":{"repoPath":"/p","mode":"uncommitted"},"lastOpenedAt":"t","commentCount":1,"staleCount":0,"viewedCount":0,"fileCount":3}]}"#).unwrap();
        let store = JsonRegistryStore::new(reg_path, dir.path().join("reviews"));
        let reg = store.load().unwrap();
        assert_eq!(reg.version, 2);
        assert_eq!(reg.repos.len(), 1, "repos preserved");
        assert!(reg.reviews.is_empty(), "pre-v2 reviews dropped");
    }

    #[test]
    fn rebuild_skips_pre_v2_review_files() {
        let dir = TempDir::new().unwrap();
        let reviews = dir.path().join("reviews");
        std::fs::create_dir_all(&reviews).unwrap();
        // A hand-written v1 review file must be ignored by rebuild.
        std::fs::write(reviews.join("0123456789abcdef.json"), r#"{"version":1,"id":"0123456789abcdef","target":{"repoPath":"/p","worktree":"main","mode":"allChanges"},"snapshot":{"baseOid":"b","capturedAt":"t"},"comments":[],"viewed":[],"createdAt":"t","lastOpenedAt":"t"}"#).unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), reviews);
        let reg = store.load().unwrap(); // missing registry → rebuild
        assert!(reg.reviews.is_empty(), "v1 review file skipped by rebuild");
    }
```

> Note: confirm the `mode` serde rename for `DiffMode` (lowercase vs camelCase) when writing the fixture JSON above — match `git/model.rs`. The migration logic does not parse `mode`, so an approximate fixture is fine as long as it deserializes; if `DiffMode` rejects the value, the file is skipped anyway (which still satisfies the assertion).

- [ ] **Step 2: Run — verify failure**

Run: `cd src-tauri && cargo test -p delta storage`
Expected: FAIL (`reg.version` is 1 / reviews not dropped; rebuild includes the v1 file).

- [ ] **Step 3: Bump `Registry::empty`** in `src-tauri/src/registry/model.rs`

```rust
    pub fn empty() -> Self {
        Registry { version: 2, repos: Vec::new(), reviews: Vec::new() }
    }
```

- [ ] **Step 4: Bump `Review::new`** in `src-tauri/src/review/model.rs`

```rust
        Review {
            version: 2,
            id,
            // ...unchanged...
```

- [ ] **Step 5: Add migration + rebuild skip** in `src-tauri/src/storage/mod.rs`

In `RegistryStore for JsonRegistryStore::load`, after a successful parse:

```rust
    fn load(&self) -> Result<Registry, String> {
        match fs::read_to_string(&self.registry_path) {
            Ok(text) => match serde_json::from_str::<Registry>(&text) {
                Ok(mut reg) => {
                    if reg.version < 2 {
                        reg.reviews.clear(); // start fresh: drop pre-v2 per-mode entries
                        reg.version = 2;
                        let _ = self.save(&reg); // persist so stale rows don't reappear
                    }
                    Ok(reg)
                }
                Err(_) => Ok(self.rebuild()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(self.rebuild()),
            Err(e) => Err(format!("read registry: {e}")),
        }
    }
```

In `rebuild()`, skip pre-v2 files:

```rust
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(review) = serde_json::from_str::<Review>(&text) {
                    if review.version < 2 {
                        continue; // start fresh: ignore pre-v2 review files
                    }
                    let name = repo_name_from_path(&review.target.repo_path);
                    reg.upsert_review(ReviewEntry::from_review(&review, 0, name));
                }
            }
```

- [ ] **Step 6: Run the suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. (`sample()` uses `Review::new` → version 2, so `registry_load_missing_rebuilds_from_reviews_dir` still finds its review.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(storage): start-fresh migration to v2 review identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Move blocking git work off the main thread

**Files:**
- Modify: `src-tauri/src/commands.rs` (`compute_diff`, `get_file_diff`, `open_review`, `refresh_review` → `async` + `spawn_blocking`)

**Interfaces:**
- Produces: same command names/return types, now `async`. Frontend `api.ts` is unchanged (invoke is transport-agnostic).

- [ ] **Step 1: Convert the four commands** in `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn compute_diff(target: Target) -> Result<DiffSummary, String> {
    tauri::async_runtime::spawn_blocking(move || compute_diff_impl(target))
        .await
        .map_err(|e| format!("compute_diff task: {e}"))?
}

#[tauri::command]
pub async fn get_file_diff(target: Target, path: String) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || get_file_diff_impl(target, path))
        .await
        .map_err(|e| format!("get_file_diff task: {e}"))?
}

#[tauri::command]
pub async fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        open_review_impl_with_registry(&storage, &reg, target)
    })
    .await
    .map_err(|e| format!("open_review task: {e}"))?
}

#[tauri::command]
pub async fn refresh_review(app: tauri::AppHandle, review: Review) -> Result<ReviewSession, String> {
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        refresh_review_impl_with_registry(&storage, &reg, review)
    })
    .await
    .map_err(|e| format!("refresh_review task: {e}"))?
}
```

(`reviews_dir` / `registry_path` are called before the closure so `app` isn't moved across the blocking boundary; the `PathBuf`s are `Send`.)

- [ ] **Step 2: Build + test**

Run: `cd src-tauri && cargo test`
Expected: PASS (impl unit tests unchanged) and clean build — proves the async wrappers compile and the closures are `Send + 'static`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "perf(commands): run git diff work off the main thread

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Window size/position restoration

**Files:**
- Modify: `src-tauri/Cargo.toml` (add dependency)
- Modify: `src-tauri/src/lib.rs` (register plugin)

**Interfaces:**
- Produces: windows auto-restore their last size/position by label; first launch uses builder defaults.

- [ ] **Step 1: Add the crate** to `src-tauri/Cargo.toml` `[dependencies]`

```toml
tauri-plugin-window-state = "2"
```

- [ ] **Step 2: Register the plugin** in `src-tauri/src/lib.rs` (after the single-instance plugin, which must stay first)

```rust
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            crate::launch::route_launch(app, &args, std::path::Path::new(&cwd));
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: compiles. (Auto save/restore needs no JS capability.)

- [ ] **Step 4: Manual verify** (real build)

Run: `pnpm tauri dev`, resize/move a window, quit, relaunch → window reopens at the saved bounds. (Cannot be checked in browser mock.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(window): persist and restore window size/position

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Cold-start (no white flash) + traffic-light position

**Files:**
- Modify: `src-tauri/src/launch/mod.rs` (both builders: `.visible(false)`, traffic-light y)
- Modify: `src-tauri/capabilities/default.json` (allow `show`/`set-focus`)
- Modify: `src/App.tsx` (show window after first paint)

**Interfaces:**
- Produces: windows are created hidden and shown by the frontend after the themed shell paints.

- [ ] **Step 1: Hide windows + nudge traffic lights** in `src-tauri/src/launch/mod.rs`

In **both** `open_target_window` and `open_home_window`, add `.visible(false)` to the cross-platform builder chain, and bump the traffic-light `y` to vertically center in the 48px header:

```rust
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("delta")
        .visible(false) // shown by the frontend after first paint (no white flash)
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    }
```

(Apply the same `.visible(false)` and `y: 18.0` to `open_home_window`.)

- [ ] **Step 2: Allow show/focus** in `src-tauri/capabilities/default.json`

```json
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "opener:default"
  ]
```

- [ ] **Step 3: Show after first paint** in `src/App.tsx` (add inside `App`, after the existing `useEffect`)

```tsx
  // Window is created hidden (Rust) to avoid a white flash; reveal it once the
  // themed shell has painted. Skipped under the browser mock (no native window).
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    const w = getCurrentWindow();
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void w.show();
        void w.setFocus();
      }),
    );
    return () => cancelAnimationFrame(id);
  }, []);
```

(`getCurrentWindow` is already imported in `App.tsx`.)

- [ ] **Step 4: Frontend tests still pass**

Run: `pnpm test`
Expected: PASS (mock path skips `show`).

- [ ] **Step 5: Manual verify** (real build) — cold start shows no white flash; traffic lights centered. Tune `y` (try 17–20) against a `pnpm tauri dev` screenshot; native chrome is not visible in the browser mock. Confirm with the user.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix(window): eliminate cold-start flash; center traffic lights

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `useDiffLayout` hook (localStorage-backed, cross-window)

**Files:**
- Create: `src/diff/useDiffLayout.ts`
- Create: `src/diff/useDiffLayout.test.tsx`

**Interfaces:**
- Produces: `type DiffLayout = "unified" | "split"`, `useDiffLayout(): [DiffLayout, (l: DiffLayout) => void]`. Key `delta:diffLayout`, default `"unified"`, syncs across windows via the `storage` event.

- [ ] **Step 1: Write the failing test** `src/diff/useDiffLayout.test.tsx`

```tsx
import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useDiffLayout } from "./useDiffLayout";

function Probe() {
  const [layout, setLayout] = useDiffLayout();
  return (
    <button data-testid="b" onClick={() => setLayout(layout === "unified" ? "split" : "unified")}>
      {layout}
    </button>
  );
}

beforeEach(() => localStorage.clear());

test("defaults to unified and persists the choice", () => {
  render(<Probe />);
  expect(screen.getByTestId("b").textContent).toBe("unified");
  act(() => screen.getByTestId("b").click());
  expect(screen.getByTestId("b").textContent).toBe("split");
  expect(localStorage.getItem("delta:diffLayout")).toBe("split");
});

test("reacts to a storage event from another window", () => {
  render(<Probe />);
  act(() => {
    localStorage.setItem("delta:diffLayout", "split");
    window.dispatchEvent(new StorageEvent("storage", { key: "delta:diffLayout", newValue: "split" }));
  });
  expect(screen.getByTestId("b").textContent).toBe("split");
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm exec vitest run src/diff/useDiffLayout.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/diff/useDiffLayout.ts`

```ts
import { useCallback, useEffect, useState } from "react";

export type DiffLayout = "unified" | "split";

const KEY = "delta:diffLayout";

function read(): DiffLayout {
  return localStorage.getItem(KEY) === "split" ? "split" : "unified";
}

// Global split/unified preference, shared across all windows of the same origin
// (localStorage is shared) and kept live via the cross-document `storage` event.
export function useDiffLayout(): [DiffLayout, (l: DiffLayout) => void] {
  const [layout, setLayoutState] = useState<DiffLayout>(read);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setLayoutState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLayout = useCallback((l: DiffLayout) => {
    localStorage.setItem(KEY, l);
    setLayoutState(l);
  }, []);

  return [layout, setLayout];
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm exec vitest run src/diff/useDiffLayout.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(diff): persisted split/unified layout hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Thread the layout through DiffView → DiffPane → Workspace + header toggle

**Files:**
- Modify: `src/diff/DiffView.tsx` (rename prop `mode` → `layout`)
- Modify: `src/diff/DiffPane.tsx` (accept `layout`, pass to `FileSection`/`DiffView`)
- Modify: `src/workspace/Workspace.tsx` (use `useDiffLayout`, add toggle, pass `layout`)

**Interfaces:**
- Consumes: `useDiffLayout()` from Task 6.
- Produces: `DiffView` prop `layout: "unified" | "split"`; `DiffPane` prop `layout: DiffLayout`.

- [ ] **Step 1: Rename the prop in `DiffView.tsx`** — replace every `mode` (the layout one) with `layout`:

```tsx
export function DiffView({
  fileDiff, filePath, layout, theme = "light", comments = [], onAddComment, onEditComment, onDeleteComment,
}: {
  fileDiff: FileDiff; filePath: string; layout: "unified" | "split"; theme?: "light" | "dark";
  comments?: Comment[];
  onAddComment?: (anchor: Anchor, body: string) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
```

And in the body: the `useMemo` dep + branch (`layout === "split" ? f.buildSplitDiffLines() : f.buildUnifiedDiffLines()`), the `useMemo([fileDiff, layout, theme])` dep array, and `diffViewMode={layout === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}`.

- [ ] **Step 2: Thread through `DiffPane.tsx`**

Add `layout` to `DiffPane`'s props and forward it to each `FileSection`; `FileSection` forwards it to `DiffView`:

```tsx
// At the top of DiffPane.tsx: import type { DiffLayout } from "./useDiffLayout";
// DiffPane props type: add `layout: DiffLayout;`
// DiffPane signature destructure: { target, files, comments, viewedFiles, theme, jump, layout, onToggleViewed, ... }
// FileSection props: add `layout: "unified" | "split";`
// FileSection <DiffView ... layout={layout} /> (was mode="unified")
// In the files.map(...), pass layout={layout} to <FileSection>
```

(Replace the hardcoded `mode="unified"` on `DiffView` at line ~169 with `layout={layout}`.)

- [ ] **Step 3: Wire it in `Workspace.tsx`**

```tsx
import { useDiffLayout } from "../diff/useDiffLayout";
import { Columns2, Rows2 } from "lucide-react";
// inside Workspace:
const [layout, setLayout] = useDiffLayout();
// pass layout={layout} to <DiffPane .../>
```

Add a compact toggle in the header action cluster (before the Comments button), e.g. a ghost button that flips layout:

```tsx
<Button
  size="sm" variant="ghost"
  className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
  onClick={() => setLayout(layout === "unified" ? "split" : "unified")}
  title={layout === "unified" ? "Switch to split view" : "Switch to unified view"}
  aria-label="Toggle split/unified diff"
>
  {layout === "split" ? <Columns2 className="size-4" /> : <Rows2 className="size-4" />}
</Button>
```

- [ ] **Step 4: Verify build + existing tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS (no remaining `mode=`/`mode:` references to the old DiffView prop; `smoke`/`Workspace` tests green).

- [ ] **Step 5: Visual check** (`pnpm dev:mock` + preview MCP): toggling the header control switches split/unified and the choice survives a reload.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(diff): split/unified toggle wired through the diff pane

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Mode switches in place; picker shows one row per worktree

**Files:**
- Modify: `src/workspace/Workspace.tsx` (local `diffMode` state; select updates state + URL; no `openTarget`)
- Modify: `src/picker/CommandPalette.tsx` (remove the mode badge)
- Modify: `src/workspace/Workspace.test.tsx` (assert in-place switch)
- Modify: `src/picker/CommandPalette.test.tsx` (assert no mode badge)

**Interfaces:**
- Consumes: `api.openReview(target)` recomputes against `target.mode` for the same id (Task 1).

- [ ] **Step 1: Read the existing tests** to match harness/mocks: `src/workspace/Workspace.test.tsx`, `src/picker/CommandPalette.test.tsx`, `src/dev/mockBackend.ts`.

- [ ] **Step 2: Write/adjust the failing Workspace test** — changing the mode select calls `openReview` with the new mode and does NOT call `openTarget`.

```tsx
// Spy on api.openReview / api.openTarget (via the mock transport or vi.spyOn(api,...)).
// Render <Workspace target={{repoPath:"/p", mode:"all-changes"}} />, wait for the header,
// change the "Diff mode" <select> to "uncommitted":
//   fireEvent.change(screen.getByLabelText("Diff mode"), { target: { value: "uncommitted" } });
// Expect: openReview called with mode "uncommitted"; openTarget NOT called.
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm exec vitest run src/workspace/Workspace.test.tsx`
Expected: FAIL (current code calls `openTarget`).

- [ ] **Step 4: Implement the in-place switch** in `Workspace.tsx`

```tsx
// replace: const mode = target.mode;
const [diffMode, setDiffMode] = useState<DiffMode>(target.mode);

// open() uses diffMode:
const session = await api.openReview({ repoPath: target.repoPath, mode: diffMode, base: target.base });

// effect deps: [target.repoPath, target.base, diffMode]

// keep the URL's mode param in sync so a window reload restores the current mode:
function syncModeParam(next: DiffMode) {
  const u = new URL(window.location.href);
  u.searchParams.set("mode", next);
  window.history.replaceState(null, "", u);
}

// the select:
<select
  aria-label="Diff mode"
  value={diffMode}
  onChange={(e) => { const next = e.target.value as DiffMode; setDiffMode(next); syncModeParam(next); }}
  ...
>
```

(Remove the `api.openTarget(...)` call from the select's `onChange`.)

- [ ] **Step 5: Remove the mode badge** in `CommandPalette.tsx`

Delete `badge: MODE_LABEL[r.target.mode],` from the root-page review mapping (line ~147). Delete the now-unused `MODE_LABEL` constant and drop `DiffMode` from the import if it becomes unused.

- [ ] **Step 6: Adjust the CommandPalette test** — root list renders one row per worktree with no mode-label badge. Update any existing assertion that expected the badge.

- [ ] **Step 7: Run — verify pass**

Run: `pnpm exec vitest run src/workspace/Workspace.test.tsx src/picker/CommandPalette.test.tsx`
Expected: PASS.

- [ ] **Step 8: Full suite + types**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 9: Visual check** (`pnpm dev:mock`): switching mode in the header stays in the same window and recomputes; the palette lists each worktree once.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(review): switch diff mode in place; de-dupe picker by worktree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: File-header actions — counts grouped right `[+adds −dels] [comment] [Viewed]`

**Files:**
- Modify: `src/diff/DiffPane.tsx` (`FileSection` header, lines ~100–138)

- [ ] **Step 1: Move the counts into the right cluster.** Remove the counts `<span>` from inside the filename span (lines ~108–111) so the filename span is just chevron + path. Then render the right cluster in order counts → add-comment → Viewed:

```tsx
        <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors group-hover:bg-foreground/[0.06] group-hover:text-foreground">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-semibold text-foreground">{base}</span>
          </span>
        </span>
        {/* Right actions, left→right: diff counts · add file comment · mark viewed */}
        <span className="relative shrink-0 text-[12px] tabular-nums">
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}{" "}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
        <Button
          size="sm" variant="ghost"
          className="relative h-7 shrink-0 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => onAddFileComment(entry.path, "")}
          aria-label={`comment on ${entry.path}`} title="Comment on file"
        >
          <MessageSquarePlus className="size-4" />
        </Button>
        <Button
          size="sm" variant="ghost"
          className={`relative h-7 shrink-0 gap-1.5 px-2 text-[12px] ${viewed ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => onToggleViewed(entry.path)}
          aria-label={`viewed ${entry.path}`} aria-pressed={viewed} title="Mark viewed"
        >
          <span className={`flex size-4 items-center justify-center rounded-[5px] border transition-colors ${viewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80"}`}>
            {viewed && <Check className="size-3" strokeWidth={3} />}
          </span>
          Viewed
        </Button>
```

- [ ] **Step 2: Types + tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 3: Visual check** (`pnpm dev:mock`): the header shows `+adds −dels` then the comment button then Viewed, all right-aligned.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(diff): group file-header actions right (counts, comment, viewed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Files-panel header (global count + viewed ratio) + list-mode padding

**Files:**
- Modify: `src/files/FilesPanel.tsx` (header layout; `flat` flag to drop chevron spacer in list mode)
- Modify: `src/files/FilesPanel.test.tsx`

- [ ] **Step 1: Write the failing tests** in `src/files/FilesPanel.test.tsx` (match the existing render helper / fixtures in that file)

```tsx
// 1) header shows global totals + viewed ratio:
//    render FilesPanel with files of known additions/deletions and a viewedFiles set;
//    expect text matching the summed "+N" and "−M", and a "X/Y viewed" string.
// 2) list mode drops the chevron spacer:
//    switch to list mode (click the List toggle), and assert a file row does NOT
//    contain the w-3.5 spacer placeholder (query by a stable marker, e.g. give the
//    spacer data-testid="tree-indent" in tree mode only and assert it's absent).
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm exec vitest run src/files/FilesPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Restructure the header** in `FilesPanel.tsx` (the `<div className="flex h-9 ...">` at line ~183)

```tsx
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]">
        <span className="tabular-nums">
          {totalAdds > 0 && <span className="text-emerald-500">+{totalAdds}</span>}{" "}
          {totalDels > 0 && <span className="text-rose-500">−{totalDels}</span>}
        </span>
        <span className="ml-auto text-muted-foreground">{viewedFiles.size}/{files.length} viewed</span>
        <ToggleGroup
          type="single" size="sm" value={mode}
          onValueChange={(v) => v && setMode(v as "tree" | "list")}
          className="gap-0.5 rounded-md bg-muted/70 p-0.5"
        >
          {/* unchanged list/tree items */}
        </ToggleGroup>
      </div>
```

Compute totals near the top of `FilesPanel` (after `files` is in scope):

```tsx
  const totalAdds = useMemo(() => files.reduce((n, f) => n + f.additions, 0), [files]);
  const totalDels = useMemo(() => files.reduce((n, f) => n + f.deletions, 0), [files]);
```

(Move the `ml-auto` from the ToggleGroup to the viewed-ratio span so the ratio + toggle sit together on the right and the global count stays left.)

- [ ] **Step 4: Drop the chevron spacer in list mode.** Add `flat: boolean` to `RowHandlers`, set `flat: mode === "list"` in the `h` object, and in `TreeBranch` render the spacer only when not flat:

```tsx
        {isDir ? (
          <ChevronRight className={`... ${open ? "rotate-90" : ""}`} />
        ) : h.flat ? null : (
          <span data-testid="tree-indent" className="w-3.5 shrink-0" />
        )}
```

- [ ] **Step 5: Run — verify pass**

Run: `pnpm exec vitest run src/files/FilesPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Types + full suite + visual**

Run: `pnpm exec tsc --noEmit && pnpm test`; then `pnpm dev:mock` to confirm the header layout and tighter list indentation.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(files): global diff count + viewed ratio header; tighten list padding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Fix file-tree jump landing at the wrong scroll position

**Files:**
- Modify: `src/diff/DiffPane.tsx` (the `jump` effect, `attempt` function, lines ~261–310)

**Root cause:** the no-`commentId` path runs a single `sec.scrollIntoView({ block: "start" })`; with `content-visibility: auto`, sections above the target use `contain-intrinsic-size` estimates that change once painted, so the one-shot scroll lands off by the estimate error.

- [ ] **Step 1: Add convergence to the file-only path.** Replace the tail of `attempt` (the part after the `if (commentId) { ... }` block) so file jumps converge like comment jumps — align the section's top to the pane top, re-measure, and repeat until stable:

```tsx
      // File-only jump: align the section header to the pane top, then converge —
      // sections above settle to real heights (content-visibility) and shift the
      // target, so re-measure until it stops moving (mirrors the comment path).
      // `sec` was fetched at the top of attempt().
      if (!sec) return;
      const pr = pane.getBoundingClientRect();
      const nr = sec.getBoundingClientRect();
      const target = Math.max(0, pane.scrollTop + (nr.top - pr.top));
      pane.scrollTop = target;
      if (Math.abs(target - lastTarget) > 2 && tries < 40) {
        jumpTimer.current = window.setTimeout(() => attempt(tries + 1, target), 32);
      }
```

(Remove the old final `sec?.scrollIntoView({ behavior: "auto", block: "start" })` line that this replaces. The `commentId` branch above is unchanged.)

- [ ] **Step 2: Types + tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS (no regressions; scroll convergence isn't unit-tested — see Step 3).

- [ ] **Step 3: Visual verify** (`pnpm dev:mock` with a multi-file fixture): single-click assorted far-down files in the tree; each lands on the file header in one click (no second-click correction). Confirm the comment-jump path still centers correctly.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix(diff): converge file-tree jumps so one click lands on the header

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: prefers-reduced-motion

**Files:**
- Modify: `src/index.css` (global reduced-motion block)

- [ ] **Step 1: Add the media query** near the base layer in `src/index.css`

```css
/* Respect the OS "reduce motion" setting: neutralize transitions/animations
   app-wide (the file tree, comment UI, and toggles use only CSS transitions). */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 2: Build + tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 3: Visual verify** — with macOS System Settings → Accessibility → Display → Reduce motion ON, the chevron-rotate / hover transitions are effectively instant.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(a11y): respect prefers-reduced-motion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm exec tsc --noEmit && pnpm test && (cd src-tauri && cargo test)` — all green.
- [ ] `pnpm dev:mock` + preview MCP: mode switch in place, palette de-duped, split/unified toggle persists across reload, file-header order, files-panel header + list padding, single-click file jumps.
- [ ] `pnpm tauri dev` (real build, native chrome): no cold-start flash, traffic lights centered, window-state restores. Confirm traffic-light `y` with the user.
- [ ] Open a PR (only if the user asks).

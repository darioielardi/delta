# Resolved Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user mark a review comment resolved (and reopen it) in the delta UI; resolved comments are dimmed in place and excluded from the "Copy for agents" export.

**Architecture:** Add a `resolved: bool` to the `Comment` model. It persists through the existing `save_review` path (whole-`Review` write) — no new Tauri command. The export filters resolved out; the registry tracks a `resolved_count`. The frontend gets a `toggleResolved` action threaded through the existing comment-callback chain (`Workspace → VirtualDiffPane → CommentBlock → CommentThread`).

**Tech Stack:** Rust (Tauri 2, serde, git2) backend; React 19 + TypeScript + Tailwind v4 frontend; Vitest (happy-dom) + `cargo test`.

## Global Constraints

- **Conventional Commits** for every commit message.
- This changes serialized types — mirror across **all layers**: Rust (`review/model.rs`, `registry/model.rs`), TS (`types.ts`), and mock fixtures (`dev/mockBackend.ts`). No `commands.rs`/`api.ts` change (no new command).
- New serde fields use `#[serde(default)]` so existing persisted reviews/registries load. No `Review.version` bump (additive optional field).
- TS `resolved`/`resolvedCount` are **required** fields (matching the existing `stale`/`staleCount`); every object literal must set them or `tsc` fails.
- Status chips follow the existing `stale` pattern: raw Tailwind color utilities (stale = `amber-*`; resolved = `emerald-*`), not custom oklch tokens. This matches how `stale` chips are already styled.
- Resolved comments are **dimmed in place** — no hiding/filtering in this slice.
- Before declaring done: `npx tsc --noEmit`, `pnpm test`, and `cargo test` (run in `src-tauri/`) all green. UI sanity via `pnpm dev:mock`.

---

### Task 1: Backend — `resolved` field on `Comment`

**Files:**
- Modify: `src-tauri/src/review/model.rs` (struct `Comment`; add a test)
- Modify: `src-tauri/src/review/reconcile.rs:142` (test helper literal)
- Modify: `src-tauri/src/commands.rs:417` (test literal)
- Modify: `src-tauri/src/registry/model.rs:134` (test helper literal)
- Modify: `src-tauri/src/export/mod.rs:81` (test helper literal)

**Interfaces:**
- Produces: `Comment.resolved: bool` (serde `resolved`, defaults `false`). Consumed by Tasks 2, 3, and the TS mirror in Task 4.

- [ ] **Step 1: Write the failing test** — append to the `tests` module in `src-tauri/src/review/model.rs` (inside the existing `#[cfg(test)] mod tests { ... }`):

```rust
    #[test]
    fn comment_resolved_defaults_false_and_serializes() {
        // Legacy JSON without `resolved` must deserialize (→ false).
        let json = r#"{"id":"c","scope":"line","body":"b","stale":false,"createdAt":"t","updatedAt":"t"}"#;
        let c: Comment = serde_json::from_str(json).unwrap();
        assert!(!c.resolved);
        // And it is always written back out.
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains("\"resolved\":false"));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test comment_resolved_defaults_false_and_serializes`
Expected: FAIL — compile error, `Comment` has no field `resolved`.

- [ ] **Step 3: Add the field** — in `src-tauri/src/review/model.rs`, in `struct Comment`, add `resolved` right after the `stale` field:

```rust
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub resolved: bool,
```

- [ ] **Step 4: Fix the four test-only struct literals** so the crate compiles. In each, add `resolved: false,` immediately before `created_at:`.

`src-tauri/src/commands.rs:417` — inside the literal `Comment { id: "c1".into(), ... stale: false, created_at: ... }`, add `resolved: false,` before `created_at`.

`src-tauri/src/review/reconcile.rs` `line_comment` helper — after `stale: false,` add:

```rust
            body: "b".into(),
            stale: false,
            resolved: false,
            created_at: "t".into(),
```

`src-tauri/src/registry/model.rs` `comment` helper — after `stale,` add `resolved: false,` before `created_at: "t".into(),`.

`src-tauri/src/export/mod.rs:81` `cmt` helper — in `Comment { id: "x".into(), scope, anchor, body: body.into(), stale, created_at: ... }`, add `resolved: false,` before `created_at`.

- [ ] **Step 5: Run the test + full crate to verify pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (new test passes; all existing tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/review/model.rs src-tauri/src/review/reconcile.rs src-tauri/src/commands.rs src-tauri/src/registry/model.rs src-tauri/src/export/mod.rs
git commit -m "feat(review): add resolved field to Comment model"
```

---

### Task 2: Backend — exclude resolved comments from the export

**Files:**
- Modify: `src-tauri/src/export/mod.rs` (the two `filter` calls + the `cmt` test helper + a new test)

**Interfaces:**
- Consumes: `Comment.resolved` (Task 1).
- Produces: `export_markdown` output omits any comment with `resolved == true`.

- [ ] **Step 1: Make the `cmt` test helper resolved-aware** so the new test can build a resolved comment. In `src-tauri/src/export/mod.rs`, change the helper signature and literal:

```rust
    fn cmt(scope: CommentScope, anchor: Option<Anchor>, body: &str, stale: bool, resolved: bool) -> Comment {
        Comment { id: "x".into(), scope, anchor, body: body.into(), stale, resolved, created_at: "t".into(), updated_at: "t".into() }
    }
```

Update the three existing callers to pass `false` for the new `resolved` arg:
- in `general_section_comes_first`: both `cmt(...)` calls gain a trailing `, false` before `)`.
- in `line_comment_has_location_snippet_and_body`: the single `cmt(...)` call gains `, false`.
- in `stale_is_marked_not_dropped`: the single `cmt(...)` call (currently ends `..., true)`) becomes `..., true, false)`.

- [ ] **Step 2: Write the failing test** — add to the `tests` module in `src-tauri/src/export/mod.rs`:

```rust
    #[test]
    fn resolved_comments_are_excluded() {
        let md = export_markdown(&review_with(vec![
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(40), end_line: None, snippet: Some("keep".into()) }), "keep me", false, false),
            cmt(CommentScope::Line, Some(Anchor { file: "src/a.ts".into(), side: Side::New, start_line: Some(41), end_line: None, snippet: Some("gone".into()) }), "resolved away", false, true),
        ]));
        assert!(md.contains("keep me"));
        assert!(!md.contains("resolved away"));
    }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src-tauri && cargo test resolved_comments_are_excluded`
Expected: FAIL — `assert!(!md.contains("resolved away"))` fails (resolved comment still exported).

- [ ] **Step 4: Add the `!c.resolved` predicate to both filters** in `export_markdown`:

The General filter (currently `.filter(|c| c.scope == CommentScope::General)`):

```rust
    let generals: Vec<&Comment> = review.comments.iter().filter(|c| c.scope == CommentScope::General && !c.resolved).collect();
```

The per-file grouping filter (currently `.filter(|c| c.scope != CommentScope::General)`):

```rust
    for c in review.comments.iter().filter(|c| c.scope != CommentScope::General && !c.resolved) {
```

- [ ] **Step 5: Run the test + crate to verify pass**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/export/mod.rs
git commit -m "feat(export): exclude resolved comments from agent export"
```

---

### Task 3: Backend — `resolved_count` on `ReviewEntry`

**Files:**
- Modify: `src-tauri/src/registry/model.rs` (struct `ReviewEntry`, `from_review`, the `comment` test helper, existing + new test)

**Interfaces:**
- Consumes: `Comment.resolved` (Task 1).
- Produces: `ReviewEntry.resolved_count: u32` (serde `resolvedCount`, `#[serde(default)]`). Mirrored in TS in Task 4.

- [ ] **Step 1: Make the `comment` test helper resolved-aware.** In `src-tauri/src/registry/model.rs`, change the helper:

```rust
    fn comment(scope: CommentScope, stale: bool, resolved: bool) -> Comment {
        Comment {
            id: "x".into(),
            scope,
            anchor: None,
            body: "b".into(),
            stale,
            resolved,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }
```

Update the three calls in `from_review_counts_exclude_general_and_track_stale_viewed` to add a trailing `, false`:

```rust
                comment(CommentScope::Line, false, false),
                comment(CommentScope::File, true, false),
                comment(CommentScope::General, false, false),
```

- [ ] **Step 2: Write the failing test** — add to the `tests` module in `src-tauri/src/registry/model.rs`:

```rust
    #[test]
    fn from_review_counts_resolved_excluding_general() {
        let r = review_with(
            vec![
                comment(CommentScope::Line, false, true),    // resolved → counts
                comment(CommentScope::File, false, true),    // resolved → counts
                comment(CommentScope::Line, false, false),   // open
                comment(CommentScope::General, false, true), // resolved but general → excluded
            ],
            vec![],
        );
        let e = ReviewEntry::from_review(&r, 0, "proj".into());
        assert_eq!(e.resolved_count, 2);
    }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src-tauri && cargo test from_review_counts_resolved_excluding_general`
Expected: FAIL — compile error, `ReviewEntry` has no field `resolved_count`.

- [ ] **Step 4: Add the struct field.** In `struct ReviewEntry`, after `pub stale_count: u32,` add:

```rust
    pub stale_count: u32,
    #[serde(default)]
    pub resolved_count: u32,
```

- [ ] **Step 5: Compute and set it in `from_review`.** After the `stale_count` line, add the count, and add the field to the returned literal:

```rust
        let stale_count = review.comments.iter().filter(|c| c.stale && visible(c)).count() as u32;
        let resolved_count = review.comments.iter().filter(|c| c.resolved && visible(c)).count() as u32;
        ReviewEntry {
            id: review.id.clone(),
            repo_name,
            target: review.target.clone(),
            last_opened_at: review.last_opened_at.clone(),
            comment_count,
            stale_count,
            resolved_count,
            viewed_count: review.viewed.len() as u32,
            file_count,
        }
```

- [ ] **Step 6: Run the test + crate to verify pass**

Run: `cd src-tauri && cargo test`
Expected: PASS. (The `#[serde(default)]` keeps `registry_load_v1_drops_reviews_keeps_repos` and the rebuild tests parsing JSON that lacks `resolvedCount`.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/registry/model.rs
git commit -m "feat(registry): track resolved_count in ReviewEntry"
```

---

### Task 4: Frontend types + fixtures + mock export

Makes the TS layer compile with the new required fields and keeps `dev:mock` honest (resolved excluded from the mock export). No new behavioral test — verified by `tsc` + the existing suite.

**Files:**
- Modify: `src/types.ts` (`Comment`, `ReviewEntry`)
- Modify: `src/review/useReview.ts` (`addComment` sets `resolved: false`)
- Modify: `src/dev/mockBackend.ts` (comment fixtures, registry fixtures, `export_review` case)
- Modify: `src/review/CommentThread.test.tsx`, `src/review/CommentIndex.test.tsx` (Comment literals)
- Modify: `src/picker/CommandPalette.test.tsx`, `src/picker/fuzzy.test.ts` (ReviewEntry literals)

**Interfaces:**
- Produces: TS `Comment.resolved: boolean`, `ReviewEntry.resolvedCount: number`. Consumed by Tasks 5–8.

- [ ] **Step 1: Add the type fields.** In `src/types.ts`, in `interface Comment` after `stale: boolean;` add `resolved: boolean;`. In `interface ReviewEntry` after `staleCount: number;` add `resolvedCount: number;`.

- [ ] **Step 2: Initialize `resolved` in `addComment`.** In `src/review/useReview.ts`, in the `comment` object literal, after `stale: false,` add `resolved: false,`.

- [ ] **Step 3: Update mock comment fixtures.** In `src/dev/mockBackend.ts`:
  - In the `REVIEW.comments` array, add `resolved: false,` to comments `c1` and `c2`; set `c3` to `resolved: true,` (demonstrates a dimmed, export-excluded comment).
  - In `genLarge`, the two `comments.push({...})` literals: add `resolved: i % 5 === 0` to the `gc${i}` push and `resolved: false` to the `gr${i}` push.

- [ ] **Step 4: Update mock registry fixtures.** In `src/dev/mockBackend.ts` `REGISTRY.reviews`, add `resolvedCount: 1,` to the `abc123` entry (after `staleCount`) and `resolvedCount: 0,` to the `def456` entry.

- [ ] **Step 5: Make the mock export reflect exclusion.** Replace the `export_review` case body in `src/dev/mockBackend.ts`:

```ts
      case "export_review": {
        const open = ds.review.comments.filter((c) => !c.resolved);
        const lines = open.map((c) => {
          const loc = c.anchor ? `${c.anchor.file}${c.anchor.startLine ? `:${c.anchor.startLine}` : ""}` : "general";
          return `- [${loc}] ${c.body}`;
        });
        return `# Review — demo · feat/auth · All changes\n\n${lines.join("\n")}\n` as T;
      }
```

- [ ] **Step 6: Fix the test fixtures** so `tsc` passes.
  - `src/review/CommentThread.test.tsx`: add `resolved: false,` to the `comments` literal (line ~7) and to the `draft` literal (line ~22).
  - `src/review/CommentIndex.test.tsx`: add `resolved: false,` to the Comment literal (line ~7).
  - `src/picker/CommandPalette.test.tsx`: add `resolvedCount: 1,` to the `abc` entry and `resolvedCount: 0,` to the `def` entry (after each `staleCount`).
  - `src/picker/fuzzy.test.ts`: add `resolvedCount: 0,` after `staleCount: 0,`.

- [ ] **Step 7: Verify typecheck + suite**

Run: `npx tsc --noEmit && pnpm test`
Expected: PASS (no type errors; all existing tests pass).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/review/useReview.ts src/dev/mockBackend.ts src/review/CommentThread.test.tsx src/review/CommentIndex.test.tsx src/picker/CommandPalette.test.tsx src/picker/fuzzy.test.ts
git commit -m "feat(types): mirror resolved fields in TS and mock fixtures"
```

---

### Task 5: Frontend — `toggleResolved` action in `useReview`

**Files:**
- Modify: `src/review/useReview.ts` (new action + return)
- Modify: `src/review/useReview.test.ts` (new test)

**Interfaces:**
- Consumes: `Comment.resolved` (Task 4).
- Produces: `toggleResolved(id: string): void` on the `useReview` return object. Consumed by Task 7.

- [ ] **Step 1: Write the failing test** — add to `src/review/useReview.test.ts` inside the `describe("useReview", ...)` block:

```ts
  it("toggleResolved flips resolved and saves immediately", async () => {
    const { result } = renderHook(() => useReview(base));
    act(() => result.current.addComment("line", null, "fix this"));
    const id = result.current.review!.comments[0].id;
    saveMock.mockReset();
    act(() => result.current.toggleResolved(id));
    expect(result.current.review!.comments[0].resolved).toBe(true);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    act(() => result.current.toggleResolved(id));
    expect(result.current.review!.comments[0].resolved).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/review/useReview.test.ts`
Expected: FAIL — `result.current.toggleResolved` is not a function.

- [ ] **Step 3: Implement the action.** In `src/review/useReview.ts`, after the `deleteComment` callback, add:

```ts
  const toggleResolved = useCallback((id: string) => {
    const now = new Date().toISOString();
    mutate(
      (r) => ({ ...r, comments: r.comments.map((c) => (c.id === id ? { ...c, resolved: !c.resolved, updatedAt: now } : c)) }),
      "now",
    );
  }, [mutate]);
```

Add `toggleResolved` to the returned object:

```ts
  return { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed, toggleResolved };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/review/useReview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/useReview.ts src/review/useReview.test.ts
git commit -m "feat(review): add toggleResolved action to useReview"
```

---

### Task 6: Frontend — resolved chip, dim, Resolve/Reopen in `CommentThread`

**Files:**
- Modify: `src/review/CommentThread.tsx` (new prop + chip + dim + button)
- Modify: `src/review/CommentThread.test.tsx` (render calls + new test)

**Interfaces:**
- Consumes: `Comment.resolved` (Task 4).
- Produces: `CommentThread` now requires prop `onToggleResolved: (id: string) => void`. Consumed by Task 7 (`CommentBlock`).

- [ ] **Step 1: Write the failing test** — add to `src/review/CommentThread.test.tsx`:

```tsx
  it("fires onToggleResolved and shows the resolved chip + Reopen", () => {
    const onToggleResolved = vi.fn();
    const open: Comment[] = [{ id: "c1", scope: "line", anchor: null, body: "note", stale: false, resolved: false, createdAt: "t", updatedAt: "t" }];
    const { rerender } = render(<CommentThread comments={open} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    fireEvent.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(onToggleResolved).toHaveBeenCalledWith("c1");
    rerender(<CommentThread comments={[{ ...open[0], resolved: true }]} onEdit={() => {}} onDelete={() => {}} onToggleResolved={onToggleResolved} />);
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reopen$/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/review/CommentThread.test.tsx`
Expected: FAIL — type error / no `Resolve` button (`onToggleResolved` not a prop yet).

- [ ] **Step 3: Add the prop** to `CommentThread`'s signature in `src/review/CommentThread.tsx`:

```tsx
export function CommentThread({
  comments,
  onEdit,
  onDelete,
  onToggleResolved,
}: {
  comments: Comment[];
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onToggleResolved: (id: string) => void;
}) {
```

- [ ] **Step 4: Dim the resolved row.** Change the display-branch container `div` (the one with `className="group flex flex-col gap-1.5 px-3.5 py-3"`) to:

```tsx
          <div key={c.id} data-comment-id={c.id} className={`group flex flex-col gap-1.5 px-3.5 py-3${c.resolved ? " opacity-55" : ""}`}>
```

- [ ] **Step 5: Add the resolved chip** immediately after the existing `{c.stale && (...)}` chip block:

```tsx
            {c.resolved && (
              <span className="flex w-fit items-center gap-1 rounded-md squircle bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">✓ Resolved</span>
            )}
```

- [ ] **Step 6: Add the Resolve/Reopen button** as the first child of the action row (the `div className="mt-2 flex gap-1.5"`):

```tsx
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => onToggleResolved(c.id)}>{c.resolved ? "Reopen" : "Resolve"}</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => open(c)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(c.id)}>Delete</Button>
            </div>
```

- [ ] **Step 7: Add `onToggleResolved` to the three existing render calls** in `src/review/CommentThread.test.tsx` (the `render(<CommentThread ... />)` lines in the first three tests) by appending `onToggleResolved={() => {}}` before the closing `/>`.

- [ ] **Step 8: Run the file's tests to verify pass**

Run: `pnpm exec vitest run src/review/CommentThread.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/review/CommentThread.tsx src/review/CommentThread.test.tsx
git commit -m "feat(review): resolved chip, dim, and Resolve/Reopen in CommentThread"
```

---

### Task 7: Frontend — thread `toggleResolved` through the diff pane; dim resolved in the index

Wires the action from `useReview` to `CommentThread` and dims resolved entries in the `CommentIndex` side panel. Verified by `tsc` + `dev:mock` (no unit test — pure prop threading).

**Files:**
- Modify: `src/workspace/Workspace.tsx` (destructure + prop)
- Modify: `src/diff/VirtualDiffPane.tsx` (`VirtualDiffPane`, `VFileSection`, `CommentBlock` prop chains + render sites)
- Modify: `src/review/CommentIndex.tsx` (dim + ✓ chip)

**Interfaces:**
- Consumes: `useReview().toggleResolved` (Task 5), `CommentThread` prop `onToggleResolved` (Task 6).
- Produces: end-to-end resolve toggle in the running UI.

- [ ] **Step 1: Destructure `toggleResolved` in `Workspace`.** In `src/workspace/Workspace.tsx`, update the `useReview` destructure:

```tsx
  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed, toggleResolved } = useReview(null);
```

- [ ] **Step 2: Pass it to `VirtualDiffPane`.** In the `<VirtualDiffPane ... />` JSX, after `onDeleteComment={deleteComment}` add:

```tsx
                onDeleteComment={deleteComment}
                onToggleResolvedComment={toggleResolved}
```

- [ ] **Step 3: Accept it on `VirtualDiffPane`.** In `src/diff/VirtualDiffPane.tsx`, add to the destructured params (after `onDeleteComment`) and to the prop type block:

In the destructure list (the `export function VirtualDiffPane({ ... onEditComment, onDeleteComment, })`): append `onToggleResolvedComment,`.

In the type block, after `onDeleteComment: (id: string) => void;` add:

```tsx
  onDeleteComment: (id: string) => void;
  onToggleResolvedComment: (id: string) => void;
```

- [ ] **Step 4: Pass it down to `VFileSection`.** In the `<VFileSection ... />` render (the line `onAddComment={onAddComment} onAddFileComment={onAddFileComment} onEditComment={onEditComment} onDeleteComment={onDeleteComment}`), append `onToggleResolvedComment={onToggleResolvedComment}`.

- [ ] **Step 5: Accept it on `VFileSection`.** In the `VFileSection` destructure (`entry, theme, ... onEditComment, onDeleteComment, reportBodyHeight, registerRef,`) add `onToggleResolvedComment,`. In its prop type block, after `onDeleteComment: (id: string) => void;` add:

```tsx
  onDeleteComment: (id: string) => void;
  onToggleResolvedComment: (id: string) => void;
```

- [ ] **Step 6: Pass it to `CommentBlock`.** In `VFileSection`'s render of `CommentBlock` (`<CommentBlock key={b.id} id={b.id} top={...} comments={b.comments} onEdit={onEditComment} onDelete={onDeleteComment} onHeight={onHeight} />`), add `onToggleResolved={onToggleResolvedComment}` before `onHeight`.

- [ ] **Step 7: Accept it on `CommentBlock` and forward to `CommentThread`.** Update the `CommentBlock` signature:

```tsx
function CommentBlock({ id, top, comments, onEdit, onDelete, onToggleResolved, onHeight }: { id: string; top: number; comments: Comment[]; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void; onToggleResolved: (id: string) => void; onHeight: (id: string, h: number) => void }) {
```

And its `<CommentThread ... />`:

```tsx
      <CommentThread comments={comments} onEdit={onEdit} onDelete={onDelete} onToggleResolved={onToggleResolved} />
```

- [ ] **Step 8: Dim + chip in `CommentIndex`.** In `src/review/CommentIndex.tsx`:

Append a dim class to the entry `button` (the one with `className="group flex w-full min-w-0 ..."`). Change its `className` from a static string to a template that adds opacity when resolved:

```tsx
            className={`group flex w-full min-w-0 shrink-0 flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-left text-[13px] shadow-xs hover:border-foreground/25 hover:bg-foreground/[0.04] dark:shadow-none${c.resolved ? " opacity-55" : ""}`}
```

Add a ✓ chip next to the existing stale chip (after the `{c.stale && <span ...>⚠ stale</span>}` line):

```tsx
              {c.resolved && <span className="shrink-0 rounded-md squircle bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">✓</span>}
```

- [ ] **Step 9: Verify typecheck + suite**

Run: `npx tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 10: Verify in the mock UI.** Start `pnpm dev:mock`, open `?view=review&repo=demo`, open the comments. Confirm: the range comment (`c3`, resolved in the fixture) is dimmed with a ✓ chip; clicking **Resolve** on an open comment dims it and flips the button to **Reopen**; **Copy for agents** output omits resolved comments. Check light + dark and unified + split. (The headless preview freezes rAF — toggle/visual state is fine to verify; don't rely on scroll-driven behavior.)

- [ ] **Step 11: Commit**

```bash
git add src/workspace/Workspace.tsx src/diff/VirtualDiffPane.tsx src/review/CommentIndex.tsx
git commit -m "feat(review): wire toggleResolved through diff pane and dim resolved in index"
```

---

### Task 8: Frontend — surface `resolvedCount` in launcher + palette

**Files:**
- Modify: `src/Home.tsx` (import + badge)
- Modify: `src/picker/CommandPalette.tsx` (import + badge)

**Interfaces:**
- Consumes: `ReviewEntry.resolvedCount` (Task 4).

- [ ] **Step 1: Home — import the icon.** In `src/Home.tsx`, add `Check` to the `lucide-react` import:

```tsx
import { Check, FolderPlus, GitBranch, MessageSquare, Settings, TriangleAlert } from "lucide-react";
```

- [ ] **Step 2: Home — add the badge** right after the `{r.staleCount > 0 && (...)}` block:

```tsx
                        {r.resolvedCount > 0 && (
                          <span className="inline-flex items-center gap-1 tabular-nums text-emerald-500">
                            <Check className="size-3.5" /> {r.resolvedCount}
                          </span>
                        )}
```

- [ ] **Step 3: CommandPalette — import the icon.** In `src/picker/CommandPalette.tsx:4`, add `Check` to the `lucide-react` import:

```tsx
import { Check, Folder, GitBranch, MessageSquare, TriangleAlert } from "lucide-react";
```

- [ ] **Step 4: CommandPalette — add the badge** right after the `{r.staleCount > 0 && (...)}` block:

```tsx
          {r.resolvedCount > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums text-emerald-500"><Check className="size-3.5" />{r.resolvedCount}</span>
          )}
```

- [ ] **Step 5: Verify typecheck + suite**

Run: `npx tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 6: Verify in the mock UI.** In `pnpm dev:mock`, the launcher / `⌘K` palette show a green ✓ count on the `abc123` review (resolvedCount: 1).

- [ ] **Step 7: Commit**

```bash
git add src/Home.tsx src/picker/CommandPalette.tsx
git commit -m "feat(home): surface resolved count in launcher and palette"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `pnpm test` — all green
- [ ] `cd src-tauri && cargo test` — all green
- [ ] `pnpm dev:mock` smoke: resolve/reopen toggles + dim, ✓ chips, resolved excluded from "Copy for agents", launcher count — in light + dark, unified + split.

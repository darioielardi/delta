# delta — UI fix backlog

Polish items for the Plan 1/2 diff + comment surface. **Not Plan 3 scope** — captured here
so they aren't forgotten; pick up after / alongside the launch layer. Each is written to be
actionable cold.

## 1. Vertical scroll dies over horizontally-scrollable files
- **Symptom:** when the cursor is over a file whose diff is wide enough to scroll horizontally,
  the mouse wheel's vertical scroll stops working (the inner scroll container swallows the event).
- **Where:** `src/diff/DiffPane.tsx` / `src/diff/DiffView.tsx` (git-diff-view scroll containers).
- **Want:** vertical wheel always scrolls the page/diff; horizontal scroll only on shift/explicit
  intent. Likely need to not trap vertical wheel in the horizontally-overflowing row container.

## 2. File-header padding is a dead zone for hover + click
- **Symptom:** hovering or clicking the *padding* area of a file header triggers neither the hover
  effect nor the click (header click target doesn't fill its own padding).
- **Where:** file header element in `src/diff/DiffPane.tsx`.
- **Want:** the hover/click target fills the full header box including padding.

## 3. Deleted files: hide by default behind a reveal
- **Symptom:** deleted files currently render/collapse like other files.
- **Where:** file rendering in `src/diff/DiffPane.tsx`.
- **Want:** deleted files are **hidden** (not just collapsed) by default — show a message
  ("File deleted") + a button to reveal the deleted content on demand.

## 4. Circle-corner pills → squircles
- **Symptom:** pills/actions use fully-rounded (`rounded-full`) corners.
- **Where:** `src/components/ui/button.tsx`, pill styles in `src/workspace/Workspace.tsx` and
  `src/index.css` (base radius token).
- **Want:** replace circle corners with squircle (continuous/superellipse) corners app-wide.
  Implementer picks technique (radius token vs true superellipse); keep it consistent.

## 5. File-header right-action order
- **Symptom:** current order is inconsistent with intent.
- **Where:** file header right actions in `src/diff/DiffPane.tsx`.
- **Want, left→right:** diff counts · mark-as-viewed · add file comment.

## 6. Cancel on an empty new comment deletes it
- **Symptom:** creating a comment then clicking "Cancel" while it's still empty leaves an
  empty comment behind.
- **Where:** `src/review/CommentEditor.tsx` + the add-comment flow
  (`src/review/CommentThread.tsx` / widget creation in `src/diff/DiffView.tsx`).
- **Want:** cancelling a just-created, never-saved comment removes it entirely (no empty remnant).

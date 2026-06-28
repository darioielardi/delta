# CLAUDE.md

Guidance for working in this repo.

## What this is

**delta** is a desktop app for reviewing git diffs and leaving structured comments meant to be handed to AI coding agents ("Copy for agents"). It's a Tauri 2 (Rust) shell hosting a React 19 + TypeScript + Tailwind v4 frontend.

## Commands

- `pnpm dev` — Vite dev server (port 1420). Renders the UI but IPC calls fail outside Tauri.
- `pnpm dev:mock` — **the UI dev/validation entry point**: `VITE_MOCK_IPC=1` on port 5599. Runs the whole UI in a plain browser against fixtures in [src/dev/mockBackend.ts](src/dev/mockBackend.ts), no Rust/Tauri needed. Open a review with `?view=review&repo=demo` (add `&large=N` for an N-file fixture).
- `pnpm tauri dev` — the real app (Rust + webview).
- `pnpm build` — `tsc && vite build` (typecheck + bundle).
- `pnpm test` / `pnpm test:watch` — Vitest (happy-dom). Rust tests: `cargo test` in `src-tauri/`.
- `pnpm doctor` — react-doctor lint.

Always run `npx tsc --noEmit` and `pnpm test` before committing.

## Validating UI changes

There is **no `tauri-driver` on macOS**, so don't drive the real app for UI checks. Instead run `pnpm dev:mock` and inspect via the preview MCP / agent-browser against `localhost:5599`. Verify both light and dark (theme is in `localStorage["delta.theme"]` = `system|light|dark`) and both diff layouts (unified/split). Note: the headless preview freezes `requestAnimationFrame`, so scroll-state-driven behavior (virtualization window, sticky-header state) can't be exercised there — verify that logic by reasoning + forcing state.

For the **real app** (real git, real IPC — things `dev:mock` can't cover, e.g. command timing or backend integration), a dev-only **eval bridge** runs inside `pnpm tauri dev` builds ([src-tauri/src/devbridge.rs](src-tauri/src/devbridge.rs), `debug_assertions` only). Run JS in the live webview and get the JSON result back over HTTP:

```
curl -s --data 'return document.querySelectorAll("[data-index]").length' http://127.0.0.1:7787/eval
curl -s --data-binary @script.js http://127.0.0.1:7787/eval   # multi-line; body is a function body that `return`s
```

The body is wrapped in an async IIFE, so `await` works; `?w=<window-label>` targets a specific window. This is how to dispatch real keystrokes (`dispatchEvent`), read DOM/state, and time interactions in the actual WKWebView.

## Architecture

**Frontend (`src/`)** — React 19 with the React Compiler (`babel-plugin-react-compiler`); `@` → `src`.
- `App.tsx` — routes to `Home` (launcher) or `Workspace` (a review) by window label / `?view`. Each window shows itself after first paint (avoids cold-start flash) and a review window closes the `home` window.
- `workspace/Workspace.tsx` — the review shell: file tree, diff pane, comments pane, toolbar, auto-refresh wiring.
- `diff/VirtualDiffPane.tsx` — **the sole diff renderer**. Row-virtualized: keeps `@git-diff-view`'s parse/diff/tokenize *model* but renders only on-screen rows itself. Files float as cards inset by `PAD` (14px) with `GAP` (10px) between them. Unified + split, fold/expand, in-code find, inline comments.
- `files/FilesPanel.tsx` — tree/list of changed files. `review/` — comment thread/editor/index + `useReview`. `picker/` — command palette. `components/ui/` — shadcn/radix primitives. `theme.ts`, `index.css` (Tailwind v4 `@theme`, oklch tokens, `gdv` layer for git-diff-view CSS).

**Backend (`src-tauri/src/`)** — Tauri 2 + git2.
- `commands.rs` — all `#[tauri::command]` handlers (the IPC surface; mirror it in `src/api.ts` and `mockBackend.ts`).
- `launch/` — window management (singleton `home`, one `review-{id}` per target), CLI parsing, registry, CLI install.
- `git/` — diff computation, language detection, repo/worktree/base resolution.
- `review/` — review model + comment reconciliation (anchors survive edits). `registry/`, `storage/` — persisted recents/reviews. `watch/` — fs watcher → `fs:changed` events for auto-refresh. `export/` — Markdown export for agents.
- `lib.rs` — plugin/command registration + the window-lifecycle run loop (reopens `home` when the last `review-` window closes).

### Window model

Singleton `home` launcher + one `review-{id}` window per target. Opening a review closes `home`; `home` reopens only after the last review window is destroyed ([App.tsx](src/App.tsx), [src-tauri/src/lib.rs](src-tauri/src/lib.rs)).

## Conventions & gotchas

- **Conventional Commits** for messages and PR titles. Keep diffs tightly scoped; don't refactor unrelated code.
- Both `@git-diff-view/file` and `@git-diff-view/react` must stay installed — one provides the model, the other the CSS.
- When adding/changing a Tauri command, update all three layers: `commands.rs`, `src/api.ts`, and `src/dev/mockBackend.ts` (or mock mode breaks).
- Styling is Tailwind v4 with oklch CSS variables (see `:root` / `.dark` in `index.css`); prefer the existing tokens (`--primary`, `--code`, etc.) over hardcoded colors. Modal dialogs are centered (the command palette is the exception).

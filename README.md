<div align="center">

# Δ&nbsp;&nbsp;delta

**Review diffs. Leave structured comments for agents.**

<img src="docs/screenshot.png" alt="delta reviewing a diff in dark mode" width="900" />

</div>

---

A fast, beautiful desktop app for reviewing git diffs and handing precise,
line-anchored feedback to AI coding agents — comment on the exact lines, then
copy the whole review as clean Markdown.

## ✨ Features

- 🚀 **Fast diffs** — row-virtualized, smooth on huge changes. Unified or split, word-level highlighting, fold/expand.
- 💬 **Structured comments** — on a line, a range, or a file. They re-anchor across edits and flag themselves stale.
- 🤖 **Copy for agents** — export the review as agent-ready Markdown.
- 🌿 **Git-native** — all changes / uncommitted / last commit / branch-vs-base, worktree-aware, auto-refresh.
- ⌨️ **Keyboard-first** — command palette, in-code find (case + whole-word), file filter, viewed tracking.

## Run it

Needs [Rust](https://www.rust-lang.org/tools/install), [Node](https://nodejs.org) + [pnpm](https://pnpm.io). macOS for now.

```bash
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # bundle
```

Install the `delta` CLI from the command palette (`⌘P` → **Install delta CLI**), then:

```bash
delta .                  # review the current repo
delta --uncommitted .    # also: --last-commit, --branch
```

## Development

```bash
pnpm dev:mock     # UI in a browser against fixtures → localhost:5599 (/?view=review&repo=demo)
pnpm test         # UI tests · cargo test in src-tauri/ for the backend
```

Architecture lives in [CLAUDE.md](CLAUDE.md). PRs welcome — keep changes scoped and the tests green.

## Built with

[Tauri 2](https://tauri.app) · [React 19](https://react.dev) · [Vite](https://vite.dev) · [Tailwind v4](https://tailwindcss.com) · [@git-diff-view](https://github.com/MrWangJustToDo/git-diff-view)

## License

[MIT](LICENSE) © Dario Ielardi

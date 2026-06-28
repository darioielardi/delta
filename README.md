<div align="center">

# Δ&nbsp;&nbsp;delta

**Review diffs. Leave structured comments for agents.**

A fast, native desktop app for reviewing git diffs and handing precise,
line-anchored feedback to AI coding agents.

<br />

<img src="docs/screenshot.png" alt="delta reviewing a diff in dark mode" width="900" />

</div>

---

## Why

Coding agents write code quickly and guess at intent slowly. delta is a focused
review surface: open a diff, drop comments on the exact lines you mean, and copy
the whole thing as clean Markdown an agent can act on — instead of pasting vague
instructions into a chat box.

## Features

- **Fast diffs** — a row-virtualized renderer stays smooth on huge changes.
  Unified or split, word-level intra-line highlighting, collapse/expand context.
- **Structured comments** — comment on a single line, a dragged range, or a
  whole file. Comments re-anchor across edits and flag themselves *stale* when
  the code beneath them moves.
- **Copy for agents** — export the entire review as Markdown shaped for AI
  coding agents to consume.
- **Built for git** — review all changes, uncommitted, the last commit, or a
  branch vs. its base. Worktree-aware, and auto-refreshes when files change on
  disk.
- **Keyboard-first** — command palette, in-code find (case-sensitive +
  whole-word), file filter, viewed tracking, jump-to-comment.
- **Native & themed** — multi-window, light/dark, open-any-file-in-your-editor.

## Run it

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) (stable),
[Node](https://nodejs.org) + [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm tauri dev      # run the app
pnpm tauri build    # produce a distributable bundle
```

Built and tested on macOS. Tauri targets Linux and Windows too, but those
aren't exercised yet.

### CLI

Install the `delta` command from the command palette (`⌘P` → **Install delta
CLI**) — it symlinks the binary onto your `PATH`. Then point it at any repo:

```bash
delta .                  # review the repo in the current directory
delta /path/to/repo
delta --uncommitted .    # also: --last-commit, --branch
```

### Shortcuts

| Key | Action |
| --- | --- |
| `⌘P` | Command palette (open a repo / worktree) |
| `⌘F` | Find in the diff |
| `⌘⇧F` | Filter files |
| `⌘2` | Toggle the comments pane |
| `⌘,` | Settings |
| `r` | Refresh the diff |

## Development

The whole UI runs in a plain browser against fixtures — no Rust build required:

```bash
pnpm dev:mock            # http://localhost:5599
# then open  /?view=review&repo=demo   (add &large=N for a big fixture)
```

```bash
npx tsc --noEmit              # typecheck
pnpm test                     # UI tests (Vitest)
cd src-tauri && cargo test    # backend tests (Rust)
```

Architecture and conventions live in [CLAUDE.md](CLAUDE.md).

## Built with

[Tauri 2](https://tauri.app) + Rust ([git2](https://docs.rs/git2)) ·
[React 19](https://react.dev) + TypeScript · [Vite](https://vite.dev) ·
[Tailwind CSS v4](https://tailwindcss.com) ·
[@git-diff-view](https://github.com/MrWangJustToDo/git-diff-view)

## Contributing

Issues and PRs welcome. Keep changes tightly scoped, follow
[Conventional Commits](https://www.conventionalcommits.org), and make sure
`pnpm test`, `cargo test`, and `npx tsc --noEmit` pass.

## License

[MIT](LICENSE) © Dario Ielardi

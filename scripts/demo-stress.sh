#!/usr/bin/env bash
# scripts/demo-stress.sh — (re)build a STRESS-TEST demo and open it in delta.
# Run via `pnpm start:demo:stress`. Creates a throwaway repo with many very big
# files, a giant diff vs main, and a pre-seeded review with lots of comments —
# to exercise virtualization, folding, and comment rendering under load.
#
# Comments live in delta's review sidecar (not git), so this writes
#   ~/Library/Application Support/com.darioielardi.delta/reviews/<id>.json
# where <id> = sha256(repoPath \0 branch)[:8] — the same id delta computes when
# it opens the worktree. It only lights up if you open via this script (or
# `delta <printed path>`), since the id is derived from that exact path.
#
# Config (env):
#   DELTA_DEMO_DIR        target path (default: ~/projects/demo-stress)
#   DELTA_STRESS_FILES    number of modified files (default: 500)
#   DELTA_STRESS_COMMENTS total comments to seed (default: 50)
#   DELTA_DEMO_OPEN       set 0 to build without launching delta (default: 1)
set -euo pipefail

# Non-interactive script: never let git pop a pager or editor. A shell that sets
# $LESS without -F (or no $EDITOR) otherwise opens a full-screen prompt mid-run.
export GIT_PAGER=cat GIT_EDITOR=true

ROOT="${DELTA_DEMO_DIR:-$HOME/projects/demo-stress}"
OPEN="${DELTA_DEMO_OPEN:-1}"
BRANCH="feat/stress"
WT="vibrant-galois-3d8f1a"
WT_PATH="$ROOT/.claude/worktrees/$WT"
REVIEWS_DIR="$HOME/Library/Application Support/com.darioielardi.delta/reviews"

die() { printf 'demo-stress: %s\n' "$*" >&2; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.delta-demo" ] || die "$ROOT exists and is not a generated demo (no .delta-demo marker) — refusing to delete it"
  rm -rf "$ROOT"
fi

# Generator (stdlib Python): deterministic big files + matching comment sidecar.
GEN="$(mktemp -t delta-stress-gen).py"
trap 'rm -f "$GEN"' EXIT
cat > "$GEN" <<'PYEOF'
import os, sys, json, hashlib

NFILES = int(os.environ.get("DELTA_STRESS_FILES", "500"))
NCOMMENTS = int(os.environ.get("DELTA_STRESS_COMMENTS", "50"))

DIRS = ["src/core", "src/api", "src/api/handlers", "src/components", "src/components/ui",
        "src/lib", "src/store/slices", "src/pages/dashboard", "src/workers", "tests/unit",
        "styles", "config"]
EXTS = ["ts", "ts", "tsx", "tsx", "css", "json", "md"]
ADDED = ["src/feature/session_store.ts", "src/feature/rate_limiter.ts", "src/feature/audit_log.ts"]
DELETED = ["src/legacy/old_cache.ts", "src/legacy/v1_router.ts"]

BODIES = [
    "This `compute()` call is on the hot path — memoize it.",
    "Extract this block into a helper; it's duplicated below.",
    "Why `retries: 2` here? Should come from config.",
    "Add a test covering this branch.",
    "Nit: name this something clearer than `v{n}`.",
    "This whole module is doing too much — split it.",
    "Possible N+1 here once this hits the store.",
    "Guard against the empty case before the loop.",
    "These magic numbers belong in config/limits.",
    "Trace flag left on — drop before merge.",
    "Confirm this matches the schema in types.ts.",
    "Looks copy-pasted from the handler above — DRY it.",
    "Big file: consider code-splitting this page.",
    "Is `trace: true` safe to ship? It logs payloads.",
    "Re-check the off-by-one at the boundary.",
]

def spec(i):
    ext = EXTS[i % len(EXTS)]
    d = DIRS[i % len(DIRS)]
    path = f"{d}/module_{i:03d}.{ext}"
    # ~20% are "giant": n>=1800 which, at ~1/3 churn, clears 1000 changed diff
    # lines per file — the "at least 20% over 1000 changed lines" target.
    giant = (i % 5 == 0)
    n = (1800 + (i % 6) * 160) if giant else (320 + (i % 7) * 60)
    return path, ext, n

def gen(path, ext, n, head):
    L = []
    if ext == "md":
        L += [f"# {path}", ""]
        for i in range(n):
            L.append(f"- updated point {i}: covers the session + rate-limit path" if (head and i % 3 == 1) else f"- point {i}")
        return L
    if ext == "json":
        L.append("{")
        for i in range(n):
            v = (i + 1) if (head and i % 2 == 0) else i
            L.append(f'  "key_{i:04d}": {v},')
        L += ['  "last": true', "}"]
        return L
    if ext == "css":
        for i in range(n):
            m = (i + 2) if (head and i % 3 == 0) else i
            L += [f".cls-{i:04d} {{", f"  margin: {m}px;", f"  padding: {i % 12}px;", "}"]
        return L
    L += ['import { compute, store } from "@/lib/util";', "", f"export function run_{n}() {{"]
    for i in range(n):
        if head and i % 3 == 1:
            L.append(f'  const v{i} = compute({i} + 1, "{path}", {{ retries: 2, trace: true }});')
        else:
            L.append(f'  const v{i} = compute({i}, "{path}");')
    L += ["  return store.read();", "}"]
    return L

def modified():
    return [(p, e, n) for (p, e, n) in (spec(i) for i in range(NFILES))]

def write_set(root, specs, head):
    for path, ext, n in specs:
        full = os.path.join(root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write("\n".join(gen(path, ext, n, head)) + "\n")

def review_id(repo_path, branch):
    h = hashlib.sha256()
    h.update(repo_path.encode()); h.update(b"\x00"); h.update(branch.encode())
    return h.digest()[:8].hex()

def cmd_base(root):
    write_set(root, modified(), head=False)
    write_set(root, [(p, "ts", 1200 + j * 200) for j, p in enumerate(DELETED)], head=False)

def cmd_head(root):
    write_set(root, modified(), head=True)
    write_set(root, [(p, "ts", 1300 + j * 200) for j, p in enumerate(ADDED)], head=True)
    for p in DELETED:
        fp = os.path.join(root, p)
        if os.path.exists(fp):
            os.remove(fp)

def cmd_sidecar(reviews_dir, repo_path, branch):
    now = "2026-06-29T12:00:00Z"
    comments, cid = [], 0
    ts_files = [(p, e, n) for (p, e, n) in modified() if e in ("ts", "tsx")]
    i = 0
    # leave room for the 6 file-scope + 2 general comments added below, so the
    # grand total lands on NCOMMENTS.
    while len(comments) < max(0, NCOMMENTS - 8) and ts_files:
        path, ext, n = ts_files[i % len(ts_files)]
        head = gen(path, ext, n, True)
        body_count = max(1, (n - 2) // 3)
        I = 1 + 3 * ((i // len(ts_files)) % body_count)   # a changed line (i%3==1)
        idx = 3 + I                                        # 0-based index into head
        i += 1
        if idx >= len(head):
            continue
        cid += 1
        kind = cid % 17
        if kind == 0:                                      # range (3 lines)
            b = min(idx + 2, len(head) - 1)
            comments.append({"id": f"c{cid}", "scope": "range",
                "anchor": {"file": path, "side": "new", "startLine": idx + 1, "endLine": b + 1, "snippet": "\n".join(head[idx:b + 1])},
                "body": BODIES[cid % len(BODIES)], "stale": False, "resolved": cid % 5 == 0, "createdAt": now, "updatedAt": now})
        elif kind == 7:                                    # intentionally unmatchable -> stale
            comments.append({"id": f"c{cid}", "scope": "line",
                "anchor": {"file": path, "side": "new", "startLine": idx + 1, "snippet": '  const vGONE = compute(-1, "removed");'},
                "body": BODIES[cid % len(BODIES)], "stale": False, "resolved": False, "createdAt": now, "updatedAt": now})
        else:                                              # line, anchored to exact head text
            comments.append({"id": f"c{cid}", "scope": "line",
                "anchor": {"file": path, "side": "new", "startLine": idx + 1, "snippet": head[idx]},
                "body": BODIES[cid % len(BODIES)], "stale": False, "resolved": cid % 6 == 0, "createdAt": now, "updatedAt": now})
    for path, ext, n in modified()[:6]:                    # whole-file comments
        cid += 1
        comments.append({"id": f"cf{cid}", "scope": "file", "anchor": {"file": path, "side": "new"},
            "body": "Whole-file: needs a focused test pass.", "stale": False, "resolved": False, "createdAt": now, "updatedAt": now})
    for body in ["Overall: this branch is huge — split into reviewable PRs.",
                 "Run the perf suite before merge; the giant modules worry me."]:
        cid += 1
        comments.append({"id": f"cg{cid}", "scope": "general", "anchor": None,
            "body": body, "stale": False, "resolved": False, "createdAt": now, "updatedAt": now})

    review = {"version": 2, "id": review_id(repo_path, branch),
              "target": {"repoPath": repo_path, "worktree": branch, "mode": "all-changes"},
              "snapshot": {"baseOid": "", "headOid": None, "capturedAt": now},
              "comments": comments, "viewed": [], "createdAt": now, "lastOpenedAt": now}
    os.makedirs(reviews_dir, exist_ok=True)
    with open(os.path.join(reviews_dir, review["id"] + ".json"), "w") as f:
        json.dump(review, f, indent=2)
    print(f'{review["id"]} {len(comments)}')

mode = sys.argv[1]
if mode == "base":
    cmd_base(sys.argv[2])
elif mode == "head":
    cmd_head(sys.argv[2])
elif mode == "sidecar":
    cmd_sidecar(sys.argv[2], sys.argv[3], sys.argv[4])
PYEOF

mkdir -p "$ROOT"; cd "$ROOT"
: > .delta-demo
git init -q -b main
git config user.name "Alex Rivera"
git config user.email "alex@example.com"
printf 'node_modules\ndist\n.claude/\n.delta-demo\n' > .gitignore

python3 "$GEN" base "$ROOT"
git add -A
git commit -q -m "initial: large service skeleton"

git branch "$BRANCH"
mkdir -p "$ROOT/.claude/worktrees"
git worktree add -q "$WT_PATH" "$BRANCH"
cd "$WT_PATH"
git config user.name "Alex Rivera"
git config user.email "alex@example.com"

python3 "$GEN" head "$WT_PATH"
git add -A
git commit -q -m "feat: sessions, rate limiting, audit log across the service"

SEED="$(python3 "$GEN" sidecar "$REVIEWS_DIR" "$WT_PATH" "$BRANCH")"
ID="${SEED%% *}"; NCOMMENTS_WRITTEN="${SEED##* }"

printf '\n✅ stress demo ready: %s\n' "$WT_PATH"
printf '   '; git diff --shortstat main...HEAD
LINES="$(git diff main...HEAD | grep -c '^[+-]')"
printf '   ~%s changed diff lines · seeded %s comments (sidecar %s.json)\n' "$LINES" "$NCOMMENTS_WRITTEN" "$ID"
printf '   base: main → %s\n' "$BRANCH"

if [ "$OPEN" = "1" ]; then
  if command -v delta >/dev/null 2>&1; then
    printf '→ opening in delta…\n'
    ( delta "$WT_PATH" >/dev/null 2>&1 & )   # detached + silenced (the app's own debug logs aren't the script's)
  else
    printf "→ 'delta' not on PATH. Run 'pnpm tauri dev', then: delta \"%s\"\n" "$WT_PATH"
    printf '   (comments only appear when opened at this exact path)\n'
  fi
fi

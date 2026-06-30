#!/usr/bin/env bash
# scripts/demo.sh — (re)build the screenshot demo repo and open it in delta.
# Run via `pnpm start:demo` whenever you want a fresh, consistent review to
# screenshot. Creates a throwaway React app ("taskboard") with a Claude-style
# worktree on feat/auth-ui and a relatable diff — added/modified/deleted
# PascalCase .tsx components — plus a handful of seeded review comments.
#
# Config (env):
#   DELTA_DEMO_DIR    target path (default: ~/projects/demo; delta shows basename)
#   DELTA_DEMO_OPEN   set 0 to build without launching delta (default: 1)
#
# Comments live in delta's review sidecar (not git), so this writes
#   ~/Library/Application Support/com.darioielardi.delta/reviews/<id>.json
# keyed by sha256(repoPath \0 branch)[:8] — the id delta computes for this
# worktree — so they appear only when opened via this script (or `delta <path>`).
#
# Safe to re-run: it only deletes a target it generated itself (.delta-demo marker).
set -euo pipefail

# Non-interactive script: never let git pop a pager or editor. A shell that sets
# $LESS without -F (or no $EDITOR) otherwise opens a full-screen prompt mid-run.
export GIT_PAGER=cat GIT_EDITOR=true

ROOT="${DELTA_DEMO_DIR:-$HOME/projects/demo}"
OPEN="${DELTA_DEMO_OPEN:-1}"
BRANCH="feat/auth-ui"
WT="keen-mendel-9c41a7"            # Claude-style worktree name
WT_PATH="$ROOT/.claude/worktrees/$WT"
REVIEWS_DIR="$HOME/Library/Application Support/com.darioielardi.delta/reviews"
REVIEWS_DIR_DEV="$HOME/Library/Application Support/com.darioielardi.delta.dev/reviews"

die() { printf 'demo: %s\n' "$*" >&2; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.delta-demo" ] || die "$ROOT exists and is not a generated demo (no .delta-demo marker) — refusing to delete it"
  rm -rf "$ROOT"
fi

mkdir -p "$ROOT"; cd "$ROOT"
: > .delta-demo
git init -q -b main
git config user.name "Alex Rivera"
git config user.email "alex@example.com"

mkdir -p src/components src/hooks src/lib src/styles

cat > .gitignore <<'EOF'
node_modules
dist
.claude/
.delta-demo
EOF

cat > package.json <<'EOF'
{
  "name": "taskboard",
  "private": true,
  "version": "0.3.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0"
  }
}
EOF

cat > index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Taskboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
EOF

cat > src/main.tsx <<'EOF'
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
EOF

cat > src/types.ts <<'EOF'
export interface Task {
  id: string;
  title: string;
  done: boolean;
}
EOF

cat > src/lib/api.ts <<'EOF'
import type { Task } from "../types";

const BASE = "/api";

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE}/tasks`);
  return res.json();
}

export async function toggleTask(id: string): Promise<void> {
  await fetch(`${BASE}/tasks/${id}/toggle`, { method: "POST" });
}
EOF

cat > src/hooks/useTasks.ts <<'EOF'
import { useEffect, useState } from "react";
import { fetchTasks } from "../lib/api";
import type { Task } from "../types";

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    fetchTasks().then(setTasks);
  }, []);

  return { tasks, setTasks };
}
EOF

cat > src/components/Header.tsx <<'EOF'
export function Header() {
  return (
    <header className="header">
      <h1>Taskboard</h1>
    </header>
  );
}
EOF

cat > src/components/Banner.tsx <<'EOF'
// Promo banner shown above the task list. Slated for removal.
export function Banner() {
  return (
    <div className="banner">
      <strong>New:</strong> drag to reorder is coming soon.
    </div>
  );
}
EOF

cat > src/components/TaskItem.tsx <<'EOF'
import type { Task } from "../types";

export function TaskItem({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <li className={task.done ? "task done" : "task"}>
      <input type="checkbox" checked={task.done} onChange={() => onToggle(task.id)} />
      <span>{task.title}</span>
    </li>
  );
}
EOF

cat > src/components/TaskList.tsx <<'EOF'
import { useTasks } from "../hooks/useTasks";
import { toggleTask } from "../lib/api";
import { TaskItem } from "./TaskItem";

export function TaskList() {
  const { tasks, setTasks } = useTasks();

  function onToggle(id: string) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    toggleTask(id);
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onToggle={onToggle} />
      ))}
    </ul>
  );
}
EOF

cat > src/App.tsx <<'EOF'
import { Header } from "./components/Header";
import { Banner } from "./components/Banner";
import { TaskList } from "./components/TaskList";

export function App() {
  return (
    <div className="app">
      <Header />
      <Banner />
      <TaskList />
    </div>
  );
}
EOF

cat > src/styles/app.css <<'EOF'
.app {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
  font-family: system-ui, sans-serif;
}

.header h1 {
  font-size: 22px;
  font-weight: 700;
}

.task-list {
  list-style: none;
  padding: 0;
}

.task {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
}

.task.done span {
  color: #9ca3af;
  text-decoration: line-through;
}
EOF

git add -A
git commit -q -m "initial: taskboard React app"

# ---------------------------------------------------------------------------
# Feature branch + Claude-style worktree
# ---------------------------------------------------------------------------
git branch "$BRANCH"
mkdir -p "$ROOT/.claude/worktrees"
git worktree add -q "$WT_PATH" "$BRANCH"
cd "$WT_PATH"
git config user.name "Alex Rivera"
git config user.email "alex@example.com"

# --- commit 1: session hook + login form ---
cat > src/types.ts <<'EOF'
export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export interface User {
  id: string;
  email: string;
}

export interface Session {
  token: string;
  user: User;
}
EOF

cat > src/lib/api.ts <<'EOF'
import type { Session, Task } from "../types";

const BASE = "/api";

let token: string | null = null;

export async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const session = (await res.json()) as Session;
  token = session.token;
  return session;
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST", headers: authHeaders() });
  token = null;
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE}/tasks`, { headers: authHeaders() });
  return res.json();
}

export async function toggleTask(id: string): Promise<void> {
  await fetch(`${BASE}/tasks/${id}/toggle`, { method: "POST", headers: authHeaders() });
}

function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}
EOF

cat > src/hooks/useSession.ts <<'EOF'
import { useCallback, useState } from "react";
import { login, logout } from "../lib/api";
import type { Session } from "../types";

export function useSession() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem("session");
    return raw ? (JSON.parse(raw) as Session) : null;
  });

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await login(email, password);
    localStorage.setItem("session", JSON.stringify(next));
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    localStorage.removeItem("session");
    setSession(null);
  }, []);

  return { session, signIn, signOut };
}
EOF

cat > src/components/LoginForm.tsx <<'EOF'
import { useState } from "react";
import { useSession } from "../hooks/useSession";

export function LoginForm() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await signIn(email, password);
    } catch {
      setError("Sign in failed");
    }
  }

  return (
    <form className="login-form" onSubmit={onSubmit}>
      <h2>Sign in</h2>
      {error && <p className="error">{error}</p>}
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input
        value={password}
        type="password"
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      <button type="submit">Continue</button>
    </form>
  );
}
EOF

git add -A
git commit -q -m "feat: add session hook and login form"

# --- commit 2: auth gate + user menu ---
cat > src/components/UserMenu.tsx <<'EOF'
import { useSession } from "../hooks/useSession";

export function UserMenu() {
  const { session, signOut } = useSession();
  if (!session) return null;

  return (
    <div className="user-menu">
      <span className="user-email">{session.user.email}</span>
      <button onClick={() => signOut()}>Sign out</button>
    </div>
  );
}
EOF

cat > src/components/Header.tsx <<'EOF'
import { UserMenu } from "./UserMenu";

export function Header() {
  return (
    <header className="header">
      <h1>Taskboard</h1>
      <UserMenu />
    </header>
  );
}
EOF

cat > src/App.tsx <<'EOF'
import { Header } from "./components/Header";
import { TaskList } from "./components/TaskList";
import { LoginForm } from "./components/LoginForm";
import { useSession } from "./hooks/useSession";

export function App() {
  const { session } = useSession();

  return (
    <div className="app">
      <Header />
      {session ? <TaskList /> : <LoginForm />}
    </div>
  );
}
EOF

git add -A
git commit -q -m "feat: wire auth gate and user menu into the shell"

# --- commit 3: per-user tasks, drop promo banner, styles ---
cat > src/hooks/useTasks.ts <<'EOF'
import { useEffect, useState } from "react";
import { fetchTasks } from "../lib/api";
import type { Session, Task } from "../types";

export function useTasks(session: Session | null) {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    if (!session) {
      setTasks([]);
      return;
    }
    fetchTasks().then(setTasks);
  }, [session]);

  return { tasks, setTasks };
}
EOF

cat > src/components/TaskList.tsx <<'EOF'
import { useTasks } from "../hooks/useTasks";
import { useSession } from "../hooks/useSession";
import { toggleTask } from "../lib/api";
import { TaskItem } from "./TaskItem";

export function TaskList() {
  const { session } = useSession();
  const { tasks, setTasks } = useTasks(session);

  function onToggle(id: string) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    toggleTask(id);
  }

  if (tasks.length === 0) {
    return <p className="empty">No tasks yet.</p>;
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onToggle={onToggle} />
      ))}
    </ul>
  );
}
EOF

git rm -q src/components/Banner.tsx

cat > src/styles/app.css <<'EOF'
.app {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
  font-family: system-ui, sans-serif;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header h1 {
  font-size: 22px;
  font-weight: 700;
}

.user-menu {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-email {
  color: #6b7280;
  font-size: 13px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 280px;
}

.login-form .error {
  color: #dc2626;
  font-size: 13px;
}

.task-list {
  list-style: none;
  padding: 0;
}

.task {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
}

.task.done span {
  color: #9ca3af;
  text-decoration: line-through;
}
EOF

cat > package.json <<'EOF'
{
  "name": "taskboard",
  "private": true,
  "version": "0.4.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0"
  }
}
EOF

git add -A
git commit -q -m "refactor: per-user tasks, drop promo banner"

# --- seed a handful of review comments (anchored to exact head lines) ---
SEED="$(python3 - "$WT_PATH" "$BRANCH" "$REVIEWS_DIR" <<'PY'
import os, sys, json, hashlib

WT, BRANCH, REVIEWS_DIR = sys.argv[1], sys.argv[2], sys.argv[3]
NOW = "2026-06-29T12:00:00Z"

# (file, marker | None, scope, body, resolved). marker=None -> file-scope; file="" -> general.
SPECS = [
    ("src/components/LoginForm.tsx", "await signIn(email, password);", "line",
     "Disable the submit button while this request is in flight.", False),
    ("src/components/LoginForm.tsx", 'setError("Sign in failed");', "line",
     "Surface the real API error here instead of a generic message.", False),
    ("src/hooks/useSession.ts", 'localStorage.setItem("session"', "line",
     "localStorage is readable by any XSS — consider an httpOnly cookie.", False),
    ("src/lib/api.ts", 'const BASE = "/api";', "line",
     "Pull the base URL from an env var so staging/prod can differ.", True),
    ("src/App.tsx", "{session ? <TaskList /> : <LoginForm />}", "line",
     "Clean auth gate — nice.", True),
    ("src/components/UserMenu.tsx", None, "file",
     "Make this menu keyboard-accessible (Esc to close, focus trap).", False),
    ("", None, "general",
     "Overall solid — ship once LoginForm shows the real sign-in error.", False),
]

def review_id(p, b):
    h = hashlib.sha256(); h.update(p.encode()); h.update(b"\x00"); h.update(b.encode())
    return h.digest()[:8].hex()

comments = []
for i, (path, marker, scope, body, resolved) in enumerate(SPECS, 1):
    base = {"id": f"c{i}", "body": body, "stale": False, "resolved": resolved,
            "createdAt": NOW, "updatedAt": NOW}
    if scope == "general":
        comments.append({**base, "scope": "general", "anchor": None})
    elif scope == "file":
        comments.append({**base, "scope": "file", "anchor": {"file": path, "side": "new"}})
    else:
        lines = open(os.path.join(WT, path)).read().split("\n")
        ln = next((n for n, l in enumerate(lines) if marker in l), None)
        if ln is None:
            raise SystemExit(f"marker not found in {path}: {marker!r}")
        comments.append({**base, "scope": "line",
                         "anchor": {"file": path, "side": "new", "startLine": ln + 1, "snippet": lines[ln]}})

review = {"version": 2, "id": review_id(WT, BRANCH),
          "target": {"repoPath": WT, "worktree": BRANCH, "mode": "all-changes"},
          "snapshot": {"baseOid": "", "headOid": None, "capturedAt": NOW},
          "comments": comments, "viewed": [], "createdAt": NOW, "lastOpenedAt": NOW}
os.makedirs(REVIEWS_DIR, exist_ok=True)
with open(os.path.join(REVIEWS_DIR, review["id"] + ".json"), "w") as f:
    json.dump(review, f, indent=2)
print(f'{review["id"]} {len(comments)}')
PY
)"
ID="${SEED%% *}"; NC="${SEED##* }"
# Mirror the sidecar into the dev build's store too (release and dev have separate
# data dirs), so the seeded comments show whichever build opens the demo.
mkdir -p "$REVIEWS_DIR_DEV" && cp "$REVIEWS_DIR/$ID.json" "$REVIEWS_DIR_DEV/" 2>/dev/null || true

# ---------------------------------------------------------------------------
printf '\n✅ demo ready: %s\n' "$WT_PATH"
printf '   '; git diff --shortstat main...HEAD
printf '   base: main → %s · seeded %s comments (sidecar %s.json)\n' "$BRANCH" "$NC" "$ID"

if [ "$OPEN" = "1" ]; then
  if command -v delta >/dev/null 2>&1; then
    printf '→ opening in delta…\n'
    ( delta "$WT_PATH" >/dev/null 2>&1 & )   # detached + silenced (the app's own debug logs aren't the script's)
  else
    printf "→ 'delta' not on PATH. Run 'pnpm tauri dev', then Add repo → %s\n" "$ROOT"
  fi
  printf '   tip: dark theme + split layout makes the best README hero shot.\n'
fi

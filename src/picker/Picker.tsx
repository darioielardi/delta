import { useEffect, useState } from "react";
import { api } from "../api";
import { rankReviews } from "./fuzzy";
import { NewReviewDrill } from "./NewReviewDrill";
import { useSystemTheme } from "../theme";
import type { DiffMode, Registry, ReviewEntry } from "../types";

const MODE_LABEL: Record<DiffMode, string> = {
  "all-changes": "All changes",
  uncommitted: "Uncommitted",
  "last-commit": "Last commit",
  "branch-vs-base": "Branch vs base",
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function Picker() {
  useSystemTheme();
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  async function reload() {
    try {
      setRegistry(await api.listRegistry());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const rows = registry ? rankReviews(registry.reviews, query) : [];
  const clampedSel = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1);

  function openRow(r: ReviewEntry) {
    void api.openTarget(r.target.repoPath, r.target.mode, r.target.base ?? undefined);
  }
  async function deleteRow(r: ReviewEntry) {
    if (!confirm(`Delete this review of ${r.repoName} · ${r.target.worktree ?? ""}?`)) return;
    try {
      await api.deleteReview(r.id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }
  async function install() {
    setError(null);
    try {
      const outcome = await api.installCli();
      setInstallMsg(
        outcome.kind === "linked"
          ? `Installed at ${outcome.path}`
          : `${outcome.reason}\n${outcome.command}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (drillOpen) return; // drill owns keys while open
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(rows.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        const r = rows[clampedSel];
        if (r) openRow(r);
      } else if (e.key === "n" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDrillOpen(true);
      } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
        const r = rows[clampedSel];
        if (r) void deleteRow(r);
      } else if (e.key === "Escape") {
        void api.hidePicker();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, clampedSel, drillOpen]);

  return (
    <div data-testid="picker-root" className="relative flex h-screen flex-col bg-background text-[13px] text-foreground">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center border-b border-border/70 pl-20 pr-3">
        <input
          autoFocus
          className="h-7 w-full rounded-md border border-input bg-muted/40 px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:bg-background"
          placeholder="Search reviews…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
        />
      </header>
      {error && (
        <div className="shrink-0 whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
          {error}
        </div>
      )}
      {installMsg && (
        <div className="shrink-0 whitespace-pre-wrap border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {installMsg}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <p>{registry ? "No reviews yet" : "Loading…"}</p>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted"
              onClick={() => setDrillOpen(true)}
            >
              ＋ New review
            </button>
          </div>
        ) : (
          rows.map((r, i) => {
            const done = r.fileCount > 0 && r.viewedCount >= r.fileCount;
            return (
              <button
                key={r.id}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${i === clampedSel ? "bg-muted" : "hover:bg-muted/60"} ${done ? "opacity-55" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => openRow(r)}
              >
                <span className="font-medium">{r.target.worktree ?? "(detached)"}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {MODE_LABEL[r.target.mode]}
                </span>
                <span className="text-[12px] text-muted-foreground">{r.repoName}</span>
                <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
                  {r.commentCount > 0 && <span>💬 {r.commentCount}</span>}
                  {r.staleCount > 0 && <span className="text-amber-600">⚠ {r.staleCount}</span>}
                  <span>{relTime(r.lastOpenedAt)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t border-border/70 px-3 py-2 text-[12px] text-muted-foreground">
        <button className="hover:text-foreground" onClick={() => setDrillOpen(true)}>
          ＋ New review <span className="opacity-60">⌘N</span>
        </button>
        <button className="hover:text-foreground" onClick={() => void install()}>
          Install <code>delta</code> CLI
        </button>
      </footer>
      {drillOpen && (
        <NewReviewDrill
          repos={registry?.repos ?? []}
          onClose={() => setDrillOpen(false)}
          onReposChanged={() => void reload()}
        />
      )}
    </div>
  );
}

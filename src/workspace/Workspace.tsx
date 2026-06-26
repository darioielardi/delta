// src/workspace/Workspace.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffPane } from "../diff/DiffPane";
import { CommentIndex } from "../review/CommentIndex";
import { useReview } from "../review/useReview";
import { useSystemTheme } from "../theme";
import { ArrowRight, Copy, MessageSquare, RefreshCw } from "lucide-react";
import type { Anchor, Comment, DiffMode, DiffSummary } from "../types";

const MODES: { id: DiffMode; label: string }[] = [
  { id: "all-changes", label: "All changes" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last-commit", label: "Last commit" },
  { id: "branch-vs-base", label: "Branch vs base" },
];

export function Workspace() {
  const theme = useSystemTheme();
  const [repoPath, setRepoPath] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("all-changes");
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);

  const { review, setReview, addComment, updateCommentBody, deleteComment, toggleViewed } = useReview(null);

  async function open(repo: string, m: DiffMode) {
    try {
      setError(null);
      const session = await api.openReview({ repoPath: repo, mode: m });
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setReview(null);
    }
  }

  useEffect(() => {
    if (opened) void open(opened, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, mode]);

  async function refresh() {
    if (!review) return;
    try {
      const session = await api.refreshReview(review);
      setReview(session.review);
      setSummary(session.summary);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyForClaude() {
    if (!review) return;
    try {
      setError(null);
      const md = await api.exportReview(review);
      await navigator.clipboard.writeText(md);
    } catch (e) {
      setError(String(e));
    }
  }

  function jumpTo(c: Comment) {
    setIndexOpen(false);
    if (c.anchor?.file) setScrollToFile(c.anchor.file + "#" + Date.now()); // force effect re-run
  }

  const viewedFiles = new Set((review?.viewed ?? []).map((v) => v.file));
  const comments = review?.comments ?? [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "2" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIndexOpen((o) => !o);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        const tag = document.activeElement?.tagName ?? "";
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (!typing) void refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  return (
    <div data-testid="app-root" className="flex h-screen flex-col bg-background text-[13px] text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-3">
        <input
          className="h-7 w-60 rounded-md border border-input bg-muted/40 px-2.5 text-[13px] outline-none transition-[color,background-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/25"
          placeholder="Repo path"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setOpened(repoPath.trim() || null); }}
        />
        <Button size="sm" variant="secondary" className="h-7" onClick={() => setOpened(repoPath.trim() || null)}>Open</Button>
        {opened && summary && (
          <>
            <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              {summary.baseLabel}
              <ArrowRight className="size-3 opacity-50" />
              {summary.headLabel}
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              value={mode}
              onValueChange={(v) => v && setMode(v as DiffMode)}
              className="ml-1 gap-0.5 rounded-lg bg-muted/70 p-0.5"
            >
              {MODES.map((m) => (
                <ToggleGroupItem
                  key={m.id}
                  value={m.id}
                  className="h-6 rounded-[6px] border-0 px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
                >
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={`Comments (${comments.length})`} className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setIndexOpen(true)}>
                <MessageSquare className="size-4" /> {comments.length}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={refresh}>
                <RefreshCw className="size-3.5" /> Refresh
              </Button>
              <Button size="sm" className="h-7 gap-1.5 px-3 text-[13px] shadow-sm" onClick={copyForClaude}>
                <Copy className="size-3.5" /> Copy for Claude
              </Button>
            </div>
          </>
        )}
      </header>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {summary && review ? (
          <>
            <aside className="flex w-80 min-h-0 shrink-0 flex-col border-r border-border/70 bg-muted/20">
              <FilesPanel
                files={summary.files}
                selected={null}
                onSelect={(p) => setScrollToFile(p + "#" + Date.now())}
                viewedFiles={viewedFiles}
                onToggleViewed={(file) => toggleViewed(file, "")}
              />
            </aside>
            <main className="min-h-0 flex-1">
              <DiffPane
                target={review.target}
                files={summary.files}
                comments={comments}
                viewedFiles={viewedFiles}
                theme={theme}
                scrollToFile={scrollToFile?.split("#")[0] ?? null}
                onToggleViewed={(file) => toggleViewed(file, "")}
                onAddComment={(anchor: Anchor, body: string) =>
                  // buildAnchor sets endLine non-null only for a multi-line range; file
                  // scope is created via onAddFileComment, never here.
                  addComment(anchor.endLine != null ? "range" : "line", anchor, body)
                }
                onAddFileComment={(file: string, body: string) =>
                  addComment("file", { file, side: "new", startLine: null, endLine: null, snippet: null }, body)
                }
                onEditComment={updateCommentBody}
                onDeleteComment={deleteComment}
              />
            </main>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">Open a repo to start a review</p>
          </div>
        )}
      </div>
      <CommentIndex
        open={indexOpen}
        onOpenChange={setIndexOpen}
        comments={comments}
        onJump={jumpTo}
        onAddGeneral={(body) => addComment("general", null, body)}
      />
    </div>
  );
}

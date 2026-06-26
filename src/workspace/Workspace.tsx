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
    const md = await api.exportReview(review);
    await navigator.clipboard.writeText(md);
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
    <div data-testid="app-root" className="flex flex-col h-screen text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <input
          className="border rounded px-2 py-1 text-xs bg-background"
          placeholder="Repo path"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
        <Button size="sm" variant="secondary" onClick={() => setOpened(repoPath.trim() || null)}>Open</Button>
        {opened && summary && (
          <>
            <span className="text-xs text-muted-foreground">{summary.baseLabel} → {summary.headLabel}</span>
            <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as DiffMode)} className="ml-2">
              {MODES.map((m) => <ToggleGroupItem key={m.id} value={m.id}>{m.label}</ToggleGroupItem>)}
            </ToggleGroup>
            <Button size="sm" variant="ghost" onClick={() => setIndexOpen(true)}>Comments ({comments.length})</Button>
            <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
            <Button size="sm" onClick={copyForClaude} className="ml-auto">Copy for Claude</Button>
          </>
        )}
      </div>
      {error && <div className="px-3 py-1 text-red-600 text-xs">{error}</div>}
      <div className="flex flex-1 min-h-0">
        {summary && review && (
          <>
            <div className="w-80 border-r min-h-0 flex flex-col">
              <FilesPanel
                files={summary.files}
                selected={null}
                onSelect={(p) => setScrollToFile(p + "#" + Date.now())}
                viewedFiles={viewedFiles}
                onToggleViewed={(file) => toggleViewed(file, "")}
              />
            </div>
            <div className="flex-1 min-h-0">
              <DiffPane
                target={review.target}
                files={summary.files}
                comments={comments}
                viewedFiles={viewedFiles}
                theme={theme}
                scrollToFile={scrollToFile?.split("#")[0] ?? null}
                onToggleViewed={(file) => toggleViewed(file, "")}
                onAddComment={(anchor: Anchor, body: string) =>
                  addComment(anchor.startLine == null ? "file" : "line", anchor, body)
                }
                onEditComment={updateCommentBody}
                onDeleteComment={deleteComment}
              />
            </div>
          </>
        )}
        {(!summary || !review) && (
          <div className="p-6 text-muted-foreground">Open a repo to start a review</div>
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

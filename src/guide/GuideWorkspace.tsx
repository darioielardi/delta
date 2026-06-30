// src/guide/GuideWorkspace.tsx
//
// Prototype "Guide" window: the AI-guidance co-pilot is the primary navigator on
// the LEFT, with the diff filling the rest. It reuses the real diff renderer; the
// walkthrough is served by the mock backend today and by the local `claude` CLI
// later. Comment editing is intentionally absent — Guide is for reading, not
// annotating — but a local "viewed" toggle is kept so the tree/diff feel live.
import { useCallback, useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArrowRight, Columns2, GitBranch, Rows2, Sparkles } from "lucide-react";
import { api } from "../api";
import { flattenTreeFiles } from "../files/buildTree";
import { VirtualDiffPane } from "../diff/VirtualDiffPane";
import { GuidePanel } from "./GuidePanel";
import { useResolvedTheme } from "../theme";
import { useDiffLayout } from "../diff/useDiffLayout";
import type { DiffSummary, Target, Walkthrough } from "../types";

const NO_COMMENTS: never[] = [];
const noop = () => {};

export function GuideWorkspace({ target }: { target: Target }) {
  const theme = useResolvedTheme();
  const [layout, setLayout] = useDiffLayout();
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [repoName, setRepoName] = useState("");
  const [reviewTarget, setReviewTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [guiding, setGuiding] = useState(false);

  const [jump, setJump] = useState<{ file: string; n: number } | null>(null);
  const [visibleFile, setVisibleFile] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(new Set());

  // Load the diff once for the target, then kick off the first walkthrough.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const session = await api.openReview({ repoPath: target.repoPath, mode: target.mode, base: target.base });
        if (cancelled) return;
        setSummary(session.summary);
        setRepoName(session.repoName);
        setReviewTarget(session.review.target);
        void generate(session.review.target);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.repoPath, target.mode, target.base]);

  async function generate(t: Target) {
    try {
      setGuiding(true);
      const w = await api.generateWalkthrough(t);
      setWalkthrough(w);
    } catch (e) {
      setError(String(e));
    } finally {
      setGuiding(false);
    }
  }

  const onRegenerate = useCallback(() => {
    if (reviewTarget) void generate(reviewTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTarget]);

  // Risk line-level jump is deferred (the diff pane's `jump` is file/comment level
  // today) — jump to the file for now; the `line` arrives for iteration 2.
  const onJump = useCallback((file: string, _line?: number | null) => setJump({ file, n: Date.now() }), []);
  const onVisibleFileChange = useCallback((p: string) => setVisibleFile(p), []);
  const toggleViewed = useCallback(
    (file: string) => setViewed((s) => { const n = new Set(s); if (n.has(file)) n.delete(file); else n.add(file); return n; }),
    [],
  );

  const orderedFiles = flattenTreeFiles(summary?.files ?? []);

  return (
    <div data-testid="guide-root" className="flex h-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-card pl-24 pr-3">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 text-[13px] font-medium text-primary">
          <Sparkles className="size-3.5" /> Guide
        </span>
        <span className="text-[13px] font-medium text-foreground">{repoName || target.repoPath.split("/").filter(Boolean).pop()}</span>
        {reviewTarget?.worktree && (
          <span className="flex items-center gap-1 font-normal text-muted-foreground">
            <GitBranch className="size-3" />
            {reviewTarget.worktree}
          </span>
        )}
        {summary && (
          <>
            <span className="flex items-center gap-1 rounded-lg squircle bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              {summary.baseLabel}
              <ArrowRight className="size-3 opacity-50" />
              {summary.headLabel}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <ToggleGroup
                type="single"
                size="sm"
                value={layout}
                onValueChange={(v) => v && setLayout(v as "unified" | "split")}
                className="gap-0.5 rounded-md bg-muted/70 p-0.5"
              >
                <ToggleGroupItem value="unified" aria-label="Unified" title="Unified view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Rows2 className="size-3.5" /></ToggleGroupItem>
                <ToggleGroupItem value="split" aria-label="Split" title="Split view" className="size-6 rounded-[5px] border-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"><Columns2 className="size-3.5" /></ToggleGroupItem>
              </ToggleGroup>
            </div>
          </>
        )}
      </header>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {summary && reviewTarget ? (
          <>
            <GuidePanel
              walkthrough={walkthrough}
              loading={guiding}
              activeFile={visibleFile}
              files={orderedFiles}
              viewedFiles={viewed}
              onToggleViewed={toggleViewed}
              onRegenerate={onRegenerate}
              onJump={onJump}
            />
            <main className="-ml-3 min-h-0 min-w-0 flex-1">
              <VirtualDiffPane
                target={reviewTarget}
                files={orderedFiles}
                theme={theme}
                layout={layout}
                viewedFiles={viewed}
                comments={NO_COMMENTS}
                jump={jump}
                onVisibleFileChange={onVisibleFileChange}
                onToggleViewed={toggleViewed}
                onAddComment={noop}
                onAddFileComment={noop}
                onEditComment={noop}
                onDeleteComment={noop}
                onToggleResolvedComment={noop}
              />
            </main>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            <span className="text-[13px]">{error ? "Couldn’t open this diff." : "Computing delta…"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

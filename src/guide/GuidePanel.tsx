// src/guide/GuidePanel.tsx
//
// The AI-guidance co-pilot — delta's primary navigator in Guide mode. Two modes:
//   • Guided — the walkthrough: a short overview, then each change-group as a clean
//     card in reading order (numbered badge → title → one-line summary → its files,
//     listed with the SAME row UI as the file tree), plus light risk flags. A
//     coverage-guaranteeing "Unsorted" card and the Ignored (noise) bucket follow.
//   • Files — the full file tree (reused FilesPanel), so the reviewer can always peek
//     at everything. The guide reorders and de-emphasizes; it never hides a file.
//
// Prototype note: the walkthrough is handed in (mock-served today, `claude` CLI later).
import { useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, ChevronDown, ChevronRight, EyeOff, Eye, Layers, FileText, TriangleAlert, CircleHelp, Check } from "lucide-react";
import { FilesPanel } from "../files/FilesPanel";
import { FileGlyph } from "../files/fileGlyph";
import type { Walkthrough, WalkGroup, WalkImportance, RiskSeverity, FileEntry } from "../types";

type Mode = "guided" | "files";

// Importance: a subtle soft badge + the timeline marker's accent. core tinted, rest grey.
const IMPORTANCE: Record<WalkImportance, { badge: string; dot: string; label: string; open: boolean }> = {
  core: { badge: "bg-primary/10 text-primary", dot: "border-primary text-primary", label: "core", open: true },
  supporting: { badge: "bg-muted text-muted-foreground", dot: "border-border text-muted-foreground", label: "supporting", open: true },
  skim: { badge: "bg-muted/50 text-muted-foreground/70", dot: "border-border text-muted-foreground/55", label: "skim", open: false },
};

// Risk = an attention marker shown as a tinted callout. caution → amber, watch →
// sky. Never red — orientation, not a defect report.
const SEVERITY: Record<RiskSeverity, { color: string; box: string }> = {
  watch: { color: "text-sky-600 dark:text-sky-400", box: "border-sky-500/20 bg-sky-500/[0.07]" },
  caution: { color: "text-amber-600 dark:text-amber-400", box: "border-amber-500/25 bg-amber-500/[0.08]" },
};

const basename = (path: string) => { const i = path.lastIndexOf("/"); return i >= 0 ? path.slice(i + 1) : path; };

// Render a one-line string with markdown-style `code` spans. A code span whose
// text resolves to a changed file becomes a clickable chip that jumps the diff to
// that file; other code spans render as inert inline code; plain text passes
// through. Inline-only by design — no block markdown in titles/summaries.
function RichText({ text, resolvePath, onJump }: {
  text: string;
  resolvePath: (token: string) => string | null;
  onJump: (path: string, line?: number | null) => void;
}) {
  if (!text.includes("`")) return <>{text}</>;
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) => {
        if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
          const code = part.slice(1, -1);
          const path = resolvePath(code);
          if (path) {
            return (
              <button
                key={i}
                type="button"
                title={`Jump to ${path}`}
                onClick={(e) => { e.stopPropagation(); onJump(path); }}
                className="cursor-pointer rounded bg-muted px-1 py-px align-baseline font-mono text-[0.85em] text-foreground/90 transition-colors hover:bg-primary/15 hover:text-primary"
              >
                {code}
              </button>
            );
          }
          return <code key={i} className="rounded bg-muted px-1 py-px align-baseline font-mono text-[0.85em] text-foreground/80">{code}</code>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function GuidePanel({
  walkthrough, loading, activeFile, files, viewedFiles, onToggleViewed, onRegenerate, onJump,
}: {
  walkthrough: Walkthrough | null;
  loading: boolean;
  activeFile?: string | null;
  files: FileEntry[];
  viewedFiles: Set<string>;
  onToggleViewed: (file: string) => void;
  onRegenerate: () => void;
  onJump: (path: string, line?: number | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("guided");

  const groups = [...(walkthrough?.groups ?? [])].sort((a, b) => a.order - b.order);
  const entryByPath = new Map(files.map((f) => [f.path, f] as const));
  // Resolve a `code` token (full path, or an unambiguous basename) to a changed
  // file, so paths mentioned in titles/summaries become clickable jump targets.
  const pathByBasename = new Map<string, string | null>();
  for (const f of files) { const b = basename(f.path); pathByBasename.set(b, pathByBasename.has(b) ? null : f.path); }
  const resolvePath = (token: string): string | null => {
    const t = token.trim();
    return entryByPath.has(t) ? t : (pathByBasename.get(t) ?? null);
  };

  // Coverage guarantee: every changed file appears somewhere. Anything the guide
  // didn't place lands in "Unsorted" so nothing silently vanishes.
  const placed = new Set<string>();
  for (const g of groups) for (const f of g.files) placed.add(f.path);
  for (const ig of walkthrough?.ignored ?? []) placed.add(ig.path);
  const unsorted = files.filter((f) => !placed.has(f.path));

  const riskTotal = groups.reduce((n, g) => n + g.risks.length, 0);
  const row = { entryByPath, viewedFiles, activeFile, onJump, onToggleViewed, resolvePath };

  // Focus model: exactly one step is "active" — the one holding the file at the top
  // of the diff viewport (scroll-spy via activeFile), falling back to the first step
  // so something is always lit. Inactive steps dim; the panel pins the active step
  // to its top as the diff scrolls.
  const activeGroupId =
    groups.find((g) => g.files.some((f) => f.path === activeFile))?.id ??
    (unsorted.some((f) => f.path === activeFile) ? "__unsorted__" : groups[0]?.id);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const firstGroupId = groups[0]?.id;
  useEffect(() => {
    const c = scrollRef.current;
    if (!c || !activeGroupId) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The overview is the guide's header: while the first step is active (incl. the
    // initial load, before the diff has been scrolled) keep the panel at the top so
    // the title + overview stay visible. Later steps pin themselves to the top.
    if (activeGroupId === firstGroupId) {
      c.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
      return;
    }
    const el = c.querySelector(`[data-step="${activeGroupId}"]`) as HTMLElement | null;
    if (!el) return;
    // Land just past the step's top divider so it isn't left peeking above the step;
    // the step's own top padding is the breathing room.
    const bt = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo({ top: Math.max(0, top + bt), behavior: smooth ? "smooth" : "auto" });
  }, [activeGroupId, firstGroupId]);

  // Marking every file in a step "viewed" advances the panel to the next step —
  // panel only, no onJump, so the diff stays put and the reader keeps their place.
  const stepsDone = useRef<Set<string>>(new Set());
  useEffect(() => {
    const c = scrollRef.current;
    const done = new Set<string>();
    for (const g of groups) if (g.files.length && g.files.every((f) => viewedFiles.has(f.path))) done.add(g.id);
    let completed: string | null = null;
    for (const g of groups) if (done.has(g.id) && !stepsDone.current.has(g.id)) { completed = g.id; break; }
    stepsDone.current = done;
    if (!completed || !c) return;
    const idx = groups.findIndex((g) => g.id === completed);
    const nextId = groups[idx + 1]?.id ?? (unsorted.length > 0 ? "__unsorted__" : null);
    if (!nextId) return;
    const el = c.querySelector(`[data-step="${nextId}"]`) as HTMLElement | null;
    if (!el) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const bt = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo({ top: Math.max(0, top + bt), behavior: smooth ? "smooth" : "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedFiles]);

  return (
    <aside className="flex h-full w-[28rem] min-h-0 shrink-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4 pt-3.5">
        <ModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          onClick={onRegenerate}
          disabled={loading}
          title="Regenerate walkthrough"
          aria-label="Regenerate walkthrough"
          className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {mode === "files" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <FilesPanel files={files} selected={activeFile ?? null} onSelect={(p) => onJump(p)} viewedFiles={viewedFiles} onToggleViewed={onToggleViewed} />
        </div>
      ) : (
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-9 overflow-auto px-5 pb-12 pt-5">
          {loading && !walkthrough ? (
            <LoadingState />
          ) : !walkthrough ? (
            <p className="py-12 text-center text-[13px] text-muted-foreground">No walkthrough yet</p>
          ) : (
            <>
              {walkthrough.degraded && (
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  Summarized from file structure — the diff was too large to read in full, so risk flags are approximate.
                </p>
              )}

              <Overview title={walkthrough.title} summary={walkthrough.summary} groupCount={groups.length} fileCount={files.length} riskTotal={riskTotal} resolvePath={resolvePath} onJump={onJump} />

              <ol className="flex flex-col">
                {groups.map((g) => (
                  <GroupCard key={g.id} group={g} total={groups.length} active={g.id === activeGroupId} {...row} />
                ))}
                {unsorted.length > 0 && <UnsortedCard files={unsorted} active={activeGroupId === "__unsorted__"} {...row} />}
              </ol>

              {walkthrough.ignored.length > 0 && <IgnoredSection ignored={walkthrough.ignored} {...row} />}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5 text-[12px] font-medium">
      {(["guided", "files"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors ${
            mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {m === "guided" ? <Sparkles className="size-3.5" /> : <FileText className="size-3.5" />}
          {m === "guided" ? "Guided" : "Files"}
        </button>
      ))}
    </div>
  );
}

function Overview({ title, summary, groupCount, fileCount, riskTotal, resolvePath, onJump }: { title: string; summary: string; groupCount: number; fileCount: number; riskTotal: number; resolvePath: (token: string) => string | null; onJump: (path: string, line?: number | null) => void }) {
  return (
    <div className="flex flex-col gap-3 px-0.5">
      <h2 className="text-[21px] font-semibold leading-tight tracking-tight text-foreground"><RichText text={title} resolvePath={resolvePath} onJump={onJump} /></h2>
      <p className="text-[13px] leading-relaxed text-muted-foreground"><RichText text={summary} resolvePath={resolvePath} onJump={onJump} /></p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Layers className="size-3.5" /> {groupCount} groups</span>
        <span className="flex items-center gap-1.5"><FileText className="size-3.5" /> {fileCount} files</span>
        {riskTotal > 0 && (
          <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400"><TriangleAlert className="size-3.5" /> {riskTotal} flag{riskTotal === 1 ? "" : "s"}</span>
        )}
      </div>
    </div>
  );
}

type RowProps = {
  entryByPath: Map<string, FileEntry>;
  viewedFiles: Set<string>;
  activeFile?: string | null;
  onJump: (path: string, line?: number | null) => void;
  onToggleViewed: (file: string) => void;
  resolvePath: (token: string) => string | null;
};

function GroupCard({ group, total, active, ...row }: { group: WalkGroup; total: number; active: boolean } & RowProps) {
  const imp = IMPORTANCE[group.importance];
  const firstFile = group.files[0]?.path;
  const activate = () => { if (firstFile) row.onJump(firstFile); };

  return (
    <li
      data-step={group.id}
      className="border-t border-border/60 py-6 first:border-t-0 first:pt-0 last:pb-0"
    >
      {/* The whole card surface activates the step (jumps the diff to its first file).
          Inner controls — file rows, risks, path chips — stop propagation and act on
          their own target instead. */}
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); activate(); } }}
        className={`transition-opacity duration-300 ${active ? "opacity-100" : "opacity-55 hover:opacity-100"}`}
      >
        <div className="flex w-full flex-col items-start gap-2">
          <span className="text-[14px] tabular-nums text-muted-foreground">
            <span className={active ? "font-bold text-foreground" : "font-semibold"}>{group.order}</span>
            <span className="mx-[0.2em] font-semibold text-muted-foreground/45">/</span>
            <span className="font-semibold text-muted-foreground/45">{total}</span>
          </span>
          <span className="flex w-full items-center gap-2.5">
            <span className="min-w-0 flex-1 text-[17px] font-semibold leading-tight text-foreground"><RichText text={group.title} resolvePath={row.resolvePath} onJump={row.onJump} /></span>
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium squircle ${imp.badge}`}>{imp.label}</span>
          </span>
        </div>

        <p className="mt-3.5 text-[13px] leading-relaxed text-muted-foreground"><RichText text={group.summary} resolvePath={row.resolvePath} onJump={row.onJump} /></p>
        <div className="mt-5 flex flex-col">
          {group.files.map((f) => (
            <GuideFileRow key={f.path} path={f.path} {...row} />
          ))}
        </div>
        {group.risks.length > 0 && (
          <div className="mt-5 flex flex-col gap-2">
            {group.risks.map((r, i) => {
              const sev = SEVERITY[r.severity];
              const Icon = r.severity === "caution" ? TriangleAlert : Eye;
              return (
                <button
                  key={`${r.path}:${r.line ?? i}`}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); row.onJump(r.path, r.line); }}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition hover:brightness-[0.98] ${sev.box}`}
                >
                <Icon className={`mt-px size-4 shrink-0 ${sev.color}`} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[12.5px] leading-snug text-foreground">{r.note}</span>
                  <span className="font-mono text-[11px] text-muted-foreground/70">{basename(r.path)}{r.line ? `:${r.line}` : ""}</span>
                </span>
              </button>
            );
          })}
          </div>
        )}
      </div>
    </li>
  );
}

// One file row — the SAME visual language as the tree/list: status glyph, name,
// and either the +/− counts or a muted trailing note (used by Ignored).
function GuideFileRow({ path, trailing, entryByPath, viewedFiles, activeFile, onJump, onToggleViewed }: { path: string; trailing?: string } & RowProps) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const entry = entryByPath.get(path);
  const viewed = viewedFiles.has(path);
  const active = path === activeFile;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onJump(path); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onJump(path); } }}
      title={path}
      className={`group flex h-[26px] select-none items-center gap-2 rounded-md px-2 ${active ? "bg-accent" : "hover:bg-foreground/[0.05]"} ${viewed && !active ? "opacity-65" : ""}`}
    >
      {entry ? <FileGlyph name={name} status={entry.status} /> : <span className="size-3.5 shrink-0" />}
      <span className="flex min-w-0 flex-1 items-baseline text-[13px]">
        {dir && <span className="min-w-0 truncate text-muted-foreground/70">{dir}</span>}
        <span className="shrink-0 text-foreground">{name}</span>
      </span>
      {trailing ? (
        <span className="shrink-0 truncate text-[11px] text-muted-foreground/60">{trailing}</span>
      ) : entry && (entry.additions > 0 || entry.deletions > 0) ? (
        <span className="shrink-0 text-[11px] tabular-nums">
          {entry.additions > 0 && <span className="text-emerald-500">+{entry.additions}</span>}
          {entry.additions > 0 && entry.deletions > 0 ? " " : ""}
          {entry.deletions > 0 && <span className="text-rose-500">−{entry.deletions}</span>}
        </span>
      ) : null}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleViewed(path); }}
        aria-label={`viewed ${path}`}
        className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${viewed ? "border-primary bg-primary text-primary-foreground" : "border-border/80 bg-card dark:bg-transparent group-hover:border-foreground/40 hover:!border-foreground/60"}`}
      >
        {viewed && <Check className="size-2.5" strokeWidth={3} />}
      </button>
    </div>
  );
}

// Coverage catch-all — files the guide didn't place. Quiet amber so the reviewer
// notices and can verify nothing important was missed.
function UnsortedCard({ files, active, ...row }: { files: FileEntry[]; active: boolean } & RowProps) {
  const firstFile = files[0]?.path;
  const activate = () => { if (firstFile) row.onJump(firstFile); };
  return (
    <li data-step="__unsorted__" className="border-t border-border/60 py-6 first:border-t-0 first:pt-0 last:pb-0">
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); activate(); } }}
        className={`transition-opacity duration-300 ${active ? "opacity-100" : "opacity-55 hover:opacity-100"}`}
      >
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-600 dark:text-amber-400">
          <CircleHelp className="size-3.5" /> Unsorted
        </span>
        <p className="mt-2 text-[12px] text-muted-foreground">{files.length} file{files.length === 1 ? "" : "s"} the guide didn’t place</p>
        <div className="mt-3.5 flex flex-col">
          {files.map((f) => (
            <GuideFileRow key={f.path} path={f.path} {...row} />
          ))}
        </div>
      </div>
    </li>
  );
}

function IgnoredSection({ ignored, ...row }: { ignored: Walkthrough["ignored"] } & RowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-muted-foreground hover:bg-foreground/[0.03]"
      >
        <EyeOff className="size-3.5" />
        <span className="font-medium">Ignored</span>
        <span className="text-muted-foreground/60">{ignored.length}</span>
        <span className="ml-auto">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-1 pt-1">
          {ignored.map((f) => (
            <GuideFileRow key={f.path} path={f.path} trailing={f.reason} {...row} />
          ))}
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3.5 pt-1">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Sparkles className="size-3.5 animate-pulse text-primary" />
        Reading the diff…
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2.5 h-3.5 w-1/2 rounded bg-muted [animation:delta-indeterminate_1.1s_ease-in-out_infinite]" />
          <div className="h-2.5 w-full rounded bg-muted/60" />
        </div>
      ))}
    </div>
  );
}

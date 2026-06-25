import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api";
import { FilesPanel } from "../files/FilesPanel";
import { DiffView } from "../diff/DiffView";
import { useSystemTheme } from "../theme";
import type { DiffMode, DiffSummary, FileDiff } from "../types";

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
  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No useCallback — React Compiler handles memoization (Global Constraints).
  async function load(repo: string, m: DiffMode) {
    try {
      setError(null);
      setSelected(null);
      setFileDiff(null);
      setSummary(await api.computeDiff({ repoPath: repo, mode: m }));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (opened) load(opened, mode);
  }, [opened, mode]);

  async function selectFile(path: string) {
    if (!opened) return;
    setSelected(path);
    try {
      setFileDiff(await api.getFileDiff({ repoPath: opened, mode }, path));
    } catch (e) {
      setError(String(e));
    }
  }

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
        {opened && (
          <>
            <span className="text-xs text-muted-foreground">{summary?.baseLabel} → {summary?.headLabel}</span>
            <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as DiffMode)} className="ml-2">
              {MODES.map((m) => (
                <ToggleGroupItem key={m.id} value={m.id}>{m.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => load(opened, mode)}>Refresh</Button>
          </>
        )}
      </div>
      {error && <div className="px-3 py-1 text-red-600 text-xs">{error}</div>}
      <div className="flex flex-1 min-h-0">
        {summary && (
          <div className="w-80 border-r min-h-0 flex flex-col">
            <FilesPanel files={summary.files} selected={selected} onSelect={selectFile} />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {fileDiff ? (
            <DiffView fileDiff={fileDiff} filePath={selected ?? ""} mode="unified" theme={theme} />
          ) : (
            <div className="p-6 text-muted-foreground">Select a file</div>
          )}
        </div>
      </div>
    </div>
  );
}

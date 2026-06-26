// Host view for the "home" window (cold launch / no review open). The command
// palette (mounted by App) opens over this backdrop.
export function Home() {
  return (
    <div
      data-testid="home-root"
      data-tauri-drag-region
      className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground"
    >
      <div className="font-mono text-2xl font-semibold tracking-tight">delta</div>
      <p className="text-[13px] text-muted-foreground">Review code changes and leave comments for Claude.</p>
      <p className="mt-2 text-[12px] text-muted-foreground">
        Press <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">⌘K</kbd> to open the command palette
      </p>
    </div>
  );
}

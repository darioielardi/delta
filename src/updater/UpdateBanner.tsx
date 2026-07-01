export interface UpdateBannerProps {
  version: string | null;
  onRestart: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ version, onRestart, onDismiss }: UpdateBannerProps) {
  return (
    <output
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
    >
      <span>Update ready{version ? ` (v${version})` : ''}.</span>
      <button
        type="button"
        onClick={onRestart}
        className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
      >
        Restart now
      </button>
      <button type="button" onClick={onDismiss} className="rounded-md px-3 py-1 text-muted-foreground">
        Later
      </button>
    </output>
  );
}

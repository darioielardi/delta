// A small fixed "DEV" pill, shown only in dev builds (running under the Vite dev
// server) so the debug app — window title "Delta (dev)", CLI `delta-dev` — is also
// distinguishable in-window from the installed release. Decorative; never blocks clicks.
export function DevBadge() {
  if (!import.meta.env.DEV) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-2 left-2 z-50 select-none rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow-sm"
      style={{ background: "#f59e0b", color: "#1c1917" }}
    >
      dev
    </div>
  );
}

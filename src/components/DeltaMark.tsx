import { useId } from "react";
import { cn } from "@/lib/utils";

// The delta brand mark: a violet→cyan gradient delta on a dark squircle, matching
// the app icon (src-tauri/icons). Decorative — pair it with a visible "delta"
// label for screen readers. Size it via `className` (e.g. `size-12`); the glyph
// scales to the box. The dark squircle is intentional in both themes — it's a
// product mark, not a themed surface.
export function DeltaMark({ className }: { className?: string }) {
  const gid = useId();
  return (
    <div
      aria-hidden
      className={cn(
        "flex select-none items-center justify-center rounded-2xl squircle bg-gradient-to-b from-[#1c2030] to-[#0b0d14]",
        className,
      )}
    >
      <svg viewBox="0 0 48 48" fill="none" className="h-[58%] w-[58%]">
        <defs>
          <linearGradient id={gid} x1="16" y1="9" x2="40" y2="39" gradientUnits="userSpaceOnUse">
            <stop stopColor="#b794f6" />
            <stop offset="0.55" stopColor="#6d72f0" />
            <stop offset="1" stopColor="#34d6f0" />
          </linearGradient>
        </defs>
        <path d="M24 9 L42 39 H6 Z" stroke={`url(#${gid})`} strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

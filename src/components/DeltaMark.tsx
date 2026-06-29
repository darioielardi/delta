import deltaMark from "@/assets/delta-mark.png";
import { cn } from "@/lib/utils";

// The delta brand mark — the actual macOS app icon (same source as the set in
// src-tauri/icons), so the UI stays pixel-identical to the Dock icon. The icon
// already bakes in the squircle, its inset margin, and a soft drop-shadow, so we
// render it as-is. Decorative — pair it with a visible "delta" label. Size via
// `className`.
export function DeltaMark({ className }: { className?: string }) {
  return (
    <img
      src={deltaMark}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("block size-12 select-none", className)}
    />
  );
}

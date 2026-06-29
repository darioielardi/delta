import { cn } from "@/lib/utils";

// Modifier and navigation glyphs (⌘ ⇧ ⌥ ⏎ …) are drawn with a smaller cap-height
// than letters at the same font size, so a combo like "⌘⇧F" reads as a tiny
// symbol next to a big letter, packed tight. We tokenize the shortcut — each
// modifier glyph is its own key, runs of letters stay one word — then bump the
// glyphs ~15% and lay the keys out with a small gap so combos breathe.
const SYMBOLS = new Set("⌘⇧⌥⌃⌫⌦↵⏎⎋↩⇪⇥↑↓←→");

function tokenize(keys: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of keys) {
    if (SYMBOLS.has(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** A keyboard-shortcut hint badge. Pass the shortcut as `keys` (e.g. "⌘⇧F",
 *  "esc"); `className` overrides the default muted styling for special placements
 *  (positioning, on-primary palettes). */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex select-none items-center gap-0.5 rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground",
        className,
      )}
    >
      {tokenize(keys).map((t, i) => (
        <span key={i} className={SYMBOLS.has(t) ? "text-[1.15em] leading-none" : undefined}>
          {t}
        </span>
      ))}
    </kbd>
  );
}

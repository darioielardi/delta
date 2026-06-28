// src/diff/DiffFind.tsx
//
// Floating in-code find box (⌘F), top-right of the diff pane. Searches the
// shown diff lines across every file; ↑/↓ (or ⏎ / ⇧⏎) step through matches,
// Esc closes. Purely presentational — match finding + navigation live in
// VirtualDiffPane. (#find)
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { RefObject } from "react";

export function DiffFind({
  query, onQueryChange, count, activeIndex, onPrev, onNext, onClose, inputRef,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  activeIndex: number; // 0-based index of the active match, or -1
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const has = query.trim().length > 0;
  const btn =
    "flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors enabled:hover:bg-foreground/[0.06] enabled:hover:text-foreground disabled:opacity-40";

  return (
    <div className="absolute right-6 top-5 z-30 flex items-center gap-1.5 rounded-lg border border-border bg-popover/95 py-1 pl-2.5 pr-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 backdrop-blur dark:ring-foreground/10">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          else if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
        }}
        placeholder="Find in code…"
        aria-label="Find in code"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        className="h-6 w-52 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <span className="min-w-[3.5rem] select-none text-right text-[11px] tabular-nums text-muted-foreground">
        {has ? (count > 0 ? `${activeIndex + 1}/${count}` : "0/0") : ""}
      </span>
      <div className="mx-0.5 h-5 w-px bg-border" />
      <button type="button" onClick={onPrev} disabled={count === 0} aria-label="Previous match" title="Previous (⇧⏎)" className={btn}>
        <ChevronUp className="size-4" />
      </button>
      <button type="button" onClick={onNext} disabled={count === 0} aria-label="Next match" title="Next (⏎)" className={btn}>
        <ChevronDown className="size-4" />
      </button>
      <button type="button" onClick={onClose} aria-label="Close find" title="Close (Esc)" className={btn}>
        <X className="size-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}

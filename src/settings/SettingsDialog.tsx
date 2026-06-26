import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Monitor, Moon, Sun } from "lucide-react";
import { useThemePref, type ThemePref } from "../theme";

// Mocked options for now — the controls render and feel real, but only Theme is
// wired up. Font family/size are placeholders we'll define behavior for later.
const FONT_FAMILIES = [
  { value: "system-mono", label: "System Mono" },
  { value: "sf-mono", label: "SF Mono" },
  { value: "jetbrains-mono", label: "JetBrains Mono" },
  { value: "fira-code", label: "Fira Code" },
  { value: "geist-mono", label: "Geist Mono" },
];
const FONT_SIZES = [11, 12, 13, 14, 15, 16];

const THEMES: { value: ThemePref; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

const selectClass =
  "h-8 appearance-none rounded-md border border-input bg-muted/40 pl-2.5 pr-7 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus:bg-background";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [theme, setTheme] = useThemePref();
  // Mocked, local-only until we decide what these should do.
  const [fontFamily, setFontFamily] = useState(FONT_FAMILIES[0].value);
  const [fontSize, setFontSize] = useState(13);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 rounded-2xl p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="text-[15px]">Settings</DialogTitle>
          <DialogDescription className="text-[12px]">
            Appearance and editor preferences.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Appearance
          </div>

          <Row
            label="Theme"
            hint="Match the system, or force light/dark."
            control={
              <ToggleGroup
                type="single"
                size="sm"
                value={theme}
                onValueChange={(v) => v && setTheme(v as ThemePref)}
                className="gap-0.5 rounded-lg bg-muted/70 p-0.5"
              >
                {THEMES.map(({ value, label, Icon }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={label}
                    title={label}
                    className="h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Code font"
            hint="Font family for diffs and code."
            control={
              <div className="relative">
                <select
                  aria-label="Code font family"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className={selectClass}
                >
                  {FONT_FAMILIES.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <Chevron />
              </div>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Code font size"
            hint="Size of code in the diff view."
            control={
              <div className="relative">
                <select
                  aria-label="Code font size"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className={selectClass}
                >
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={s}>{s}px</option>
                  ))}
                </select>
                <Chevron />
              </div>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

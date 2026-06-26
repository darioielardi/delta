import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Workspace } from "./workspace/Workspace";
import { Home } from "./Home";
import { CommandPalette } from "./picker/CommandPalette";
import { resolveRoute } from "./route";

function readLabel(): string | null {
  if (import.meta.env.VITE_MOCK_IPC) return null;
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

export default function App() {
  const route = resolveRoute(readLabel(), window.location.search);
  // The home window opens with the palette up; a review opens with it closed (⌘K to summon).
  const [paletteOpen, setPaletteOpen] = useState(route.kind === "home");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "o") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Windows are created hidden (Rust) to avoid a white flash; reveal once React
  // has committed the themed shell. Skipped under the browser mock (no native
  // window). Do NOT gate this on requestAnimationFrame: a hidden window is not
  // composited, so rAF never fires and the window would stay hidden forever.
  // useEffect runs after commit regardless of visibility, so the DOM is laid out
  // by the time we show.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC) return;
    let w: ReturnType<typeof getCurrentWindow>;
    try {
      w = getCurrentWindow();
    } catch {
      return; // not in a Tauri window (tests / plain browser)
    }
    void (async () => {
      try {
        await w.show();
        await w.setFocus();
      } catch {
        /* show/focus not permitted in this context — ignore */
      }
    })();
  }, []);

  return (
    <>
      {route.kind === "review" ? (
        <Workspace target={route.target} onOpenPalette={() => setPaletteOpen(true)} />
      ) : (
        <Home />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

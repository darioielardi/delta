import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  const isReview = route.kind === "review";
  // The ⌘K palette is a review-window affordance; the home window is the launcher.
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isReview) return; // no command palette on the launch screen (#6)
      if ((e.key === "k" || e.key === "o") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isReview]);

  // Windows are created hidden (Rust) to avoid a white flash; reveal once React
  // has committed the themed shell. Skipped under the browser mock (no native
  // window). Do NOT gate on requestAnimationFrame: a hidden window is not
  // composited, so rAF never fires and the window would stay hidden forever.
  // Once a review window is visible, close the launch window (#10) — doing it
  // here (post-show) avoids a blank gap during the home→review handoff.
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
        if (isReview) {
          const home = await WebviewWindow.getByLabel("home");
          if (home) await home.close();
        }
      } catch {
        /* show/focus/close not permitted in this context — ignore */
      }
    })();
  }, [isReview]);

  return (
    <>
      {isReview ? (
        <Workspace target={route.target} onOpenPalette={() => setPaletteOpen(true)} />
      ) : (
        <Home />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

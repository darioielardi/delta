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

  // Once a review window is up, close the launch window (#10). Windows are
  // created visible (the macOS window background follows the system theme, so
  // no white flash) — and crucially, NOT hiding/showing keeps the native
  // traffic-light position from resetting. Skipped under the browser mock.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK_IPC || !isReview) return;
    void (async () => {
      try {
        const home = await WebviewWindow.getByLabel("home");
        if (home) await home.close();
      } catch {
        /* not in a Tauri window / close not permitted — ignore */
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

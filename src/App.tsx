import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Workspace } from "./workspace/Workspace";
import { Home } from "./Home";
import { CommandPalette } from "./picker/CommandPalette";
import { SettingsDialog } from "./settings/SettingsDialog";
import { resolveRoute } from "./route";
import { addRepo } from "./picker/pickerActions";
import { useApplyTheme } from "./theme";

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
  // Apply the theme preference at the root so BOTH windows (home + review) honor
  // it — previously only Workspace toggled `.dark`, so the launcher was stuck
  // light (#7).
  useApplyTheme();
  // The ⌘K palette is a review-window affordance; the home window is the launcher.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Settings is global — openable from either window with ⌘, (#5).
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSettingsOpen((o) => !o);
        return;
      }
      // ⌘O imports a repo from anywhere — Home or a review, picker open or not.
      if (e.key === "o" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(false);
        void addRepo();
        return;
      }
      if (!isReview) return; // no command palette on the launch screen (#6)
      if ((e.key === "k" || e.key === "p") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isReview]);

  // Windows are created hidden (Rust visible:false); show()+setFocus() reveals
  // and activates after React commits — a real show (orderFront) that works even
  // when `cargo run`/tauri-dev launched the app in the background, where show()
  // on an already-visible window is a no-op and setFocus() can't steal focus.
  // Call show() directly, NOT via rAF (a hidden window isn't composited, so rAF
  // never fires). Then close the launcher (#10). Skipped under the browser mock.
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
        /* not in a Tauri window / not permitted — ignore */
      }
    })();
  }, [isReview]);

  return (
    <>
      {isReview ? (
        <Workspace
          target={route.target}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <Home onOpenSettings={() => setSettingsOpen(true)} />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} current={route.kind === "review" ? route.target : undefined} />}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

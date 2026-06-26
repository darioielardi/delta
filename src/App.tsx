import { getCurrentWindow } from "@tauri-apps/api/window";
import { Workspace } from "./workspace/Workspace";
import { Picker } from "./picker/Picker";
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
  return route.kind === "review" ? <Workspace target={route.target} /> : <Picker />;
}

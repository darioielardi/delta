import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

async function bootstrap() {
  // Dev-only: install the fixture IPC backend so the app runs without Tauri
  // (autonomous UI/behavior verification). Gated + dynamically imported so it
  // is tree-shaken from production / `tauri dev` builds.
  //
  // Also honored: `?mock=1` in a dev build (incl. `tauri dev`) — lets a single
  // window run on fixtures inside the real desktop shell. Used by the dev-only
  // "Walkthrough" button to preview the Guide experience with mocked data,
  // before the backend `generate_walkthrough` command exists. (#guide-dev)
  const mockParam = import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";
  if (import.meta.env.VITE_MOCK_IPC || mockParam) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();

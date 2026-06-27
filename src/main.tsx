import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

async function bootstrap() {
  // Dev-only: install the fixture IPC backend so the app runs without Tauri
  // (autonomous UI/behavior verification). Gated + dynamically imported so it
  // is tree-shaken from production / `tauri dev` builds.
  if (import.meta.env.VITE_MOCK_IPC) {
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

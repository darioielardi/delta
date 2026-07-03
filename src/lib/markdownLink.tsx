import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Components } from "react-markdown";

// Schemes we hand off to the OS default handler (browser, mail client, dialer).
const EXTERNAL = /^(https?|mailto|tel):/i;

function openExternal(href: string) {
  // In the Tauri webview, route through the opener plugin so the OS default app
  // handles it. Under the browser mock / plain-browser dev / tests there's no
  // plugin IPC, so fall back to a normal new-tab open.
  if (isTauri()) void openUrl(href).catch(() => {});
  else window.open(href, "_blank", "noopener,noreferrer");
}

// Shared react-markdown component overrides — pass as `components={markdownComponents}`
// wherever we render user- or file-authored markdown (file preview, comment bodies).
//
// react-markdown emits bare <a href> links. In the single-window Tauri webview a
// plain click would navigate the window, dropping the ?repo=… query the whole SPA
// route is built from — stranding the app on a dead route (the "open repo: unable
// to find path" failure). So we intercept every click: never navigate the webview;
// open genuine external URLs in the user's browser, and leave relative/anchor links
// (repo files & sections, not app routes) inert. (#preview-links)
export const markdownComponents: Components = {
  a({ href, title, children }) {
    return (
      <a
        href={href}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          if (href && EXTERNAL.test(href)) openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
};

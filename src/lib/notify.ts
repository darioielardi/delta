// A tiny app-wide notice channel. Lets non-component code (e.g. the shared
// `addRepo` action) surface a modal without threading state through every call
// site: `App` subscribes once and renders the dialog. Per-window — each webview
// has its own module instance, and `App` is the only subscriber.
export interface Notice {
  title: string;
  message?: string;
}

const listeners = new Set<(n: Notice) => void>();

/** Subscribe to notices. Returns an unsubscribe fn (use as an effect cleanup). */
export function onNotice(fn: (n: Notice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Emit a notice to every current subscriber. No-op if nobody is listening. */
export function notify(n: Notice): void {
  listeners.forEach((fn) => fn(n));
}

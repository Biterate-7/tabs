/**
 * Which shell the shared TabDump frontend is running inside.
 *
 * This is the ONLY place that answers that question. The rule the rest of
 * the codebase follows: product logic never asks. A handful of narrow
 * seams ask — `src/lib/platform/index.ts`, `src/lib/browser/open-tab.ts`,
 * `src/lib/auth/client.ts` — and everything else stays identical on both
 * platforms, because it genuinely is identical.
 *
 * `__TAURI_INTERNALS__` (not `__TAURI__`) is the marker: the latter only
 * exists when `withGlobalTauri` is enabled, which src-tauri/tauri.conf.json
 * deliberately leaves off. The former is injected by the Tauri runtime
 * itself before any app script runs.
 *
 * Returns false during server rendering and during the static export's
 * prerender, which is correct — there is no webview then. Callers must
 * therefore only consult this from event handlers and effects, never from
 * a render path, or the desktop build would hydrate against markup that
 * disagreed with it.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export function platformKind(): "web" | "desktop" {
  return isDesktop() ? "desktop" : "web";
}

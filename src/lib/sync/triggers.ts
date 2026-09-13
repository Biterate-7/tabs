/**
 * When to sync: reconnect, focus, tab becoming visible, and a slow timer.
 *
 * Separate from the engine so the engine stays free of browser globals and
 * testable without a DOM, and so there is exactly one place responsible for
 * removing every listener it added.
 *
 *
 * ## Coalescing
 *
 * A returning user typically fires `online`, `focus` and `visibilitychange`
 * within a few milliseconds of each other, and the timer may be due as well.
 * Each of those calls the same `trigger`, and the engine's per-workspace lock
 * turns them into one sync — but they are additionally rate-limited here, so
 * four events do not become four passes through the scheduler.
 *
 *
 * ## navigator.onLine
 *
 * Used only as a hint that it is worth *trying* again. It reports whether a
 * network interface exists, not whether our server can be reached — a
 * captive portal is "online" — so the authority on connectivity remains an
 * actual failed request, which the engine records as `offline`.
 */

const DEFAULT_PERIOD_MS = 60_000;
/** Two triggers closer together than this collapse into one. */
const COALESCE_MS = 2_000;

export type SyncTriggerOptions = {
  periodMs?: number;
  now?: () => number;
  /** Only sync while the document is visible. A hidden tab has no user to serve and no reason to poll. */
  requireVisible?: boolean;
};

/**
 * Wires the triggers and returns a teardown.
 *
 * The teardown removes every listener and clears the timer. Calling it twice
 * is safe, which matters under StrictMode: React mounts, unmounts and
 * remounts an effect in development, and a subscription that did not clean
 * up would leave two of everything.
 */
export function installSyncTriggers(trigger: () => void, options: SyncTriggerOptions = {}): () => void {
  if (typeof window === "undefined") return () => {};

  const periodMs = options.periodMs ?? DEFAULT_PERIOD_MS;
  const now = options.now ?? Date.now;
  const requireVisible = options.requireVisible ?? true;

  let lastRun = 0;
  let disposed = false;

  const fire = () => {
    if (disposed) return;
    if (requireVisible && typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const at = now();
    if (at - lastRun < COALESCE_MS) return;
    lastRun = at;
    trigger();
  };

  const onOnline = () => fire();
  const onFocus = () => fire();
  const onVisibility = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") fire();
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const timer = window.setInterval(fire, periodMs);

  return () => {
    disposed = true;
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(timer);
  };
}

/** A hint that a request is worth attempting. Never treated as proof the server is reachable. */
export function looksOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

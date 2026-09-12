/**
 * Where TabDump's own API lives, as seen from whichever shell is running.
 *
 * On the web this is the empty string, so every call site keeps issuing the
 * *same relative, same-origin request it always has* — `/api/titles` stays
 * `/api/titles`, the session cookie keeps flowing, and the Origin check in
 * src/lib/auth/origin.ts keeps passing. Nothing about the deployed site
 * changes.
 *
 * A packaged desktop build is served from `tauri://localhost`, where a
 * relative `/api/...` resolves to the bundle itself and 404s. Setting
 * `NEXT_PUBLIC_TABDUMP_API_ORIGIN` at build time points those calls at a
 * deployed TabDump instead.
 *
 * It is deliberately UNSET for the v1 desktop build, and that is a
 * correctness decision rather than an omission:
 *
 * - The backend sends no CORS headers, so a cross-origin call from the
 *   desktop origin would be blocked by the browser engine regardless of
 *   what this is set to. Enabling it means adding an explicit
 *   `Access-Control-Allow-Origin` allowlist entry for the desktop origin on
 *   the unauthenticated routes (/api/titles, /api/ai/*) first.
 * - The session cookie could not ride along anyway: it is HttpOnly and
 *   SameSite=Lax, and every auth fetch uses `credentials: "same-origin"`.
 *   Making desktop sign-in work needs the pairing flow described in
 *   docs/auth-architecture.md and docs/desktop-architecture.md — not a
 *   relaxed cookie.
 *
 * Everything the desktop app actually needs is local-first, and the two
 * server-backed extras degrade on their own: title resolution already falls
 * back to domain names when /api/titles is unreachable (see
 * src/lib/titles/client/queue.ts), and Auto-Organize already falls back to
 * deterministic clustering without the AI routes.
 *
 * Written as a direct `process.env.NEXT_PUBLIC_…` member access because
 * that is the form Next's bundler statically replaces — a computed lookup
 * would come back undefined in the browser.
 */

const CONFIGURED = process.env.NEXT_PUBLIC_TABDUMP_API_ORIGIN;

/** Normalised origin with any trailing slash removed, or "" for same-origin. */
export function apiOrigin(): string {
  const raw = CONFIGURED?.trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

/** `path` must start with "/". Returns it unchanged when same-origin. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}${path}`;
}

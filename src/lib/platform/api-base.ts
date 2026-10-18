/**
 * Where Hubble's own API lives, as seen from whichever shell is running.
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
 * deployed Hubble instead.
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
 * Everything the desktop app actually needs is local-first, and the
 * server-backed extras degrade on their own: title resolution falls back to
 * domain names (src/lib/titles/client/queue.ts), and section organizing
 * falls back to deterministic clustering without the AI routes. On desktop
 * `apiUrl` refuses rather than resolving: a relative path there is answered
 * by the bundled app itself, which serves its own index.html with a 200 for
 * any unknown path — so the call fails at once, as the network failure every
 * caller already handles, instead of parsing a web page as an API answer.
 *
 * The routes that ARE reachable from desktop are the public, cookie-free
 * ones that answer any origin (the reader and the favicon resolver); they go
 * through `publicApiUrl`.
 *
 * Written as a direct `process.env.NEXT_PUBLIC_…` member access because
 * that is the form Next's bundler statically replaces — a computed lookup
 * would come back undefined in the browser.
 */

import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";
import { isDesktop } from "./detect";

const CONFIGURED = process.env.NEXT_PUBLIC_TABDUMP_API_ORIGIN;

/** Normalised origin with any trailing slash removed, or "" for same-origin. */
export function apiOrigin(): string {
  const raw = CONFIGURED?.trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

/** Thrown by `apiUrl` in a desktop build that has no server to call. */
export class ServerUnavailableError extends Error {
  constructor(path: string) {
    super(`${path} isn't available in Hubble Desktop.`);
    this.name = "ServerUnavailableError";
  }
}

/**
 * `path` must start with "/". Returns it unchanged when same-origin.
 *
 * Throws `ServerUnavailableError` in the desktop app when no API origin is
 * configured (see above). Every caller makes its request inside a try, so
 * this lands in the same branch as being offline.
 */
export function apiUrl(path: string): string {
  const origin = apiOrigin();
  if (!origin && isDesktop()) throw new ServerUnavailableError(path);
  return `${origin}${path}`;
}

/**
 * A public, cookie-free route that answers any origin — the source reader and
 * the favicon resolver. Same-origin on the web; from the desktop app, which
 * ships no server, the deployed Hubble (CSP `connect-src` allows exactly
 * that origin). Never use this for a route that reads a session.
 */
export function publicApiUrl(path: string, platform: "web" | "desktop" = isDesktop() ? "desktop" : "web"): string {
  return `${apiOrigin() || (platform === "desktop" ? CANONICAL_PRODUCTION_ORIGIN : "")}${path}`;
}

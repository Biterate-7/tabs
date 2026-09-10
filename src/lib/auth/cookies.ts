import "server-only";

/**
 * Minimal Cookie/Set-Cookie handling for the auth route handlers.
 *
 * The existing route handlers in src/app/api/ take a plain `Request` and
 * return a plain `Response` (see api/titles/route.ts), which keeps them
 * trivially unit-testable without a Next server. Using `cookies()` from
 * `next/headers` would trade that away, and Next's own docs list reading
 * `request.headers` / returning `Set-Cookie` as an equally supported path —
 * so the auth routes stay on the same plain-Request shape as their
 * neighbours. This is header parsing, not cryptography; nothing here
 * decides trust.
 */

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  /** Seconds. `0` expires the cookie immediately, which is how deletion is expressed. */
  maxAge?: number;
};

/** Reads one cookie out of a request's `Cookie` header. Returns null when the header, or that cookie, is absent. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      // A value we never wrote (hand-crafted, or mangled by another writer).
      // Treated as absent rather than trusted raw.
      return null;
    }
  }
  return null;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    // Expires alongside Max-Age: every current browser honours Max-Age, but
    // an explicit past Expires is what makes deletion unambiguous for any
    // intermediary that only understands the older attribute.
    if (options.maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/**
 * Every auth response is per-user and must never be stored by anything in
 * between. `/api/auth/me` is the one that matters most: a shared cache that
 * held onto one browser's `{authenticated: true, user: …}` and replayed it
 * to the next would be a cross-account identity leak. Vercel does not cache
 * dynamic routes, and never caches a response carrying Set-Cookie — this is
 * the explicit belt to that braces, and it also covers any corporate proxy
 * or CDN sitting in front of the deployment.
 */
const NO_STORE = "private, no-store, max-age=0";

/**
 * Builds a JSON response carrying one or more `Set-Cookie` headers.
 * `Headers.append` (not `set`) is what allows more than one of them on a
 * single response — `set` would collapse them into one and only the last
 * cookie would survive.
 *
 * Used for every auth response, including those with no cookies at all, so
 * the no-store header above cannot be forgotten on a new branch.
 */
export function jsonWithCookies(
  body: unknown,
  init: { status?: number; cookies?: string[]; headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": NO_STORE });
  for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
  for (const cookie of init.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

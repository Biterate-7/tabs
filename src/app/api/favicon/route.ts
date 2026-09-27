import "server-only";
import { faviconHostKey } from "@/lib/favicon/host";
import { resolveFavicon } from "@/lib/favicon/server/resolve";

export const runtime = "nodejs";

/**
 * GET /api/favicon?host=console.cloud.google.com → that site's own icon.
 *
 * Deliberately NOT a proxy: it takes a hostname, never a URL, and can only
 * ever return an image the site itself declares (or its /favicon.ico),
 * after the bytes have been verified to be one. Every network hop goes
 * through src/lib/favicon/server/safe-fetch.ts's SSRF guard.
 *
 * Unauthenticated and cookie-free on purpose: it is fetched by the web app
 * and, cross-origin, by the desktop app (see src/lib/favicon/client.ts), and
 * knows nothing about the user — hence `Access-Control-Allow-Origin: *`.
 *
 * A found icon is the image bytes. A miss is `200` + JSON
 * `{ icon: null, reason }`, never an image and never an error status:
 * "this site has no favicon" is a normal answer, and the client needs the
 * reason — "not-found" (reached the site, nothing there) vs "unreachable"
 * (the server couldn't get through; the browser may still) — to decide
 * whether to try the site directly.
 *
 * Caching is the whole performance story. The CDN keys on the full URL, so
 * each host is resolved roughly once a day across every user, and browsers
 * keep the bytes for a day. A miss is cached briefly, never permanently, so
 * a site that adds (or fixes) its favicon shows up within the hour.
 */

/** The route's own cap on one resolution, inside any platform limit. */
const RESOLVE_BUDGET_MS = 9000;

const FOUND_CACHE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";
const MISSING_CACHE = "public, max-age=600, s-maxage=3600";
const INVALID_CACHE = "public, max-age=86400, s-maxage=86400";

/**
 * Third-party bytes served from Hubble's origin. An SVG opened directly (not
 * through <img>) is a document that could run script as Hubble; the sandbox
 * + default-src 'none' policy makes it inert, and nosniff stops a browser
 * reinterpreting anything as HTML.
 */
const CONTENT_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  // The desktop app reads this from its own origin; no credentials are involved.
  "access-control-allow-origin": "*",
  "cross-origin-resource-policy": "cross-origin",
};

function miss(status: 200 | 400, reason: string, cacheControl: string): Response {
  return Response.json({ icon: null, reason }, { status, headers: { ...CONTENT_HEADERS, "cache-control": cacheControl } });
}

export async function GET(request: Request): Promise<Response> {
  const host = faviconHostKey(new URL(request.url).searchParams.get("host"));
  if (!host) return miss(400, "invalid-host", INVALID_CACHE);

  const result = await resolveFavicon(host, { signal: AbortSignal.timeout(RESOLVE_BUDGET_MS) });
  if (!result.ok) {
    return result.reason === "invalid-host"
      ? miss(400, result.reason, INVALID_CACHE)
      : miss(200, result.reason, MISSING_CACHE);
  }

  return new Response(new Uint8Array(result.body), {
    status: 200,
    headers: {
      ...CONTENT_HEADERS,
      "content-type": result.contentType,
      "content-length": String(result.body.length),
      "cache-control": FOUND_CACHE,
    },
  });
}

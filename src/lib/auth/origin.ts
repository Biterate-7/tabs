import "server-only";

/**
 * Same-origin enforcement for the state-changing auth routes.
 *
 * `SameSite=Lax` on the session and nonce cookies is the primary CSRF
 * defence — a cross-site POST simply doesn't carry them. This is the second
 * layer, for the cases SameSite alone doesn't cover: a browser that doesn't
 * enforce it, and a same-site-but-different-origin sibling (anything that
 * ends up served from a related host).
 *
 * There is no CSRF *token* here, and deliberately so: the session cookie is
 * SameSite=Lax, the mutating routes are POST-only, and they require a JSON
 * content type — which a form/img/script cross-site request cannot set
 * without triggering a preflight that the absence of CORS headers then
 * fails. Adding a token would mean a second server-side store to hold it,
 * for no reachable attack it closes.
 */

/** First entry of a header a chain of proxies may each have appended to; the one closest to the client is the one that matters. */
function firstValue(header: string): string {
  return header.split(",")[0].trim();
}

/**
 * The host this request was actually addressed to, and the scheme — but
 * only when something authoritative told us the scheme.
 *
 * The scheme is deliberately NOT guessed. An earlier version defaulted to
 * `https` for any host that didn't literally start with "localhost", which
 * meant a developer on `http://127.0.0.1:3000` (or `[::1]`, or any
 * self-hosted plain-http deployment) had every mutating auth request
 * rejected with a 403 that looked like a security failure rather than a
 * bad guess. `null` here means "unknown", and the comparison below adapts.
 */
function expectedTarget(request: Request): { host: string; proto: string | null } | null {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto");
  return { host: firstValue(host), proto: proto ? firstValue(proto) : null };
}

/** The full origin, when the scheme is actually known. Exported for diagnostics; the comparison below does not depend on it. */
export function expectedOrigin(request: Request): string | null {
  const target = expectedTarget(request);
  if (!target?.proto) return null;
  return `${target.proto}://${target.host}`;
}

/**
 * False only when the browser told us the request came from somewhere else.
 *
 * A missing `Origin` header is treated as acceptable rather than hostile:
 * it means the request wasn't cross-origin as far as the browser was
 * concerned, and rejecting it would break non-browser callers (curl, a
 * health check) for no security gain — the cookie policy, not this header,
 * is what actually stops the cross-site case.
 *
 * When a proxy has told us the scheme (always true on Vercel), the whole
 * origin must match. When nothing has — no proxy in front, i.e. local
 * development — the host and port must still match exactly, and only the
 * scheme is left out of the comparison. That is not a meaningful weakening:
 * an attacker who could make a browser send `Origin: http://<our host>` to
 * our https deployment would need to already control that host's plain-http
 * port, and browsers block the mixed-content request that would produce it.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const target = expectedTarget(request);
  if (!target) return true;

  if (target.proto) return origin === `${target.proto}://${target.host}`;

  // Scheme unknown: compare the authority only. A malformed Origin (or the
  // literal "null" a sandboxed iframe sends) fails to parse and is refused.
  try {
    return new URL(origin).host === target.host;
  } catch {
    return false;
  }
}

/**
 * A cross-site `<form>` post, `<img>`, or classic script tag can only ever
 * produce a "simple" content type (form-encoded, plain text, multipart).
 * Requiring JSON means such a request must be preflighted, and nothing here
 * answers a preflight with permissive CORS headers, so it never arrives.
 */
export function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (!contentType) return false;
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

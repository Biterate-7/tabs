import { CANONICAL_PRODUCTION_ORIGIN, resolveProductionOrigin } from "./production-origin.mjs";

export { CANONICAL_PRODUCTION_ORIGIN };

/**
 * The origin this deployment is reachable at, for absolute URLs in metadata
 * (canonical links, Open Graph, Twitter cards).
 *
 * Resolved by the same function the extension ZIP build uses
 * (./production-origin.mjs), so the site's own canonical URL and the
 * extension's host permissions can't describe different origins — the kind of
 * mismatch nobody notices until sign-in or a dump quietly stops working.
 */
export function siteOrigin(): string {
  return resolveProductionOrigin(process.env);
}

/** An absolute URL for `path` on this deployment's origin. */
export function siteUrl(path = "/"): string {
  return new URL(path, siteOrigin()).toString();
}

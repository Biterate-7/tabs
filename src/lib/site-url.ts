/**
 * The origin this deployment is reachable at, for absolute URLs in metadata
 * (canonical links, Open Graph, Twitter cards).
 *
 * Mirrors the precedence already used when the extension ZIP is built
 * (scripts/build-extension-zip.mjs): an explicit override first, then Vercel's
 * per-deployment URL for previews, then the canonical production origin. The
 * two are kept deliberately consistent — the extension's host permissions and
 * the site's own canonical URL describing different origins is the kind of
 * mismatch nobody notices until sign-in or a dump quietly stops working.
 *
 * The production origin is duplicated here rather than imported because that
 * build script is a plain .mjs run by Node outside the Next build graph;
 * build-extension-zip.test.mjs asserts the value it uses, and this constant is
 * asserted alongside it in site-url.test.ts.
 */
export const CANONICAL_PRODUCTION_ORIGIN = "https://tabsdump.vercel.app";

export function siteOrigin(): string {
  const explicit = process.env.TABDUMP_PRODUCTION_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, "");

  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return CANONICAL_PRODUCTION_ORIGIN;
}

/** An absolute URL for `path` on this deployment's origin. */
export function siteUrl(path = "/"): string {
  return new URL(path, siteOrigin()).toString();
}

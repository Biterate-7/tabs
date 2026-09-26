// The one place Hubble's production origin is decided.
//
// Consumed by the extension ZIP build (scripts/build-extension-zip.mjs, a plain
// Node script outside the Next build graph — hence .mjs), by the site's own
// canonical/Open Graph URLs (src/lib/site-url.ts), and by the Claude Desktop
// MCP bridge's default endpoint (scripts/tabdump-mcp-bridge.mjs). They must
// never disagree: the packaged extension only ever matches, queries and opens
// the single origin baked into it, so an extension built against one host and
// a site that lives at another means every dump opens a tab somewhere the
// user's Hubble isn't.
//
// No Node or browser APIs in here, so both runtimes can import it as-is.

export const DEV_ORIGIN = "http://localhost:3000";

// Fallback only — for builds that run outside Vercel's pipeline (a developer's
// `npm run build`, the desktop export) and so have no Vercel system env vars.
// A Vercel production build uses VERCEL_PROJECT_PRODUCTION_URL instead, which
// Vercel derives from the project's own domain settings at build time, so a
// domain added or removed in the Vercel dashboard is picked up by the next
// deploy without anyone editing this line. Keep this equal to what that
// variable resolves to, so a local build and a Vercel build agree.
//
// This is the production domain configured on the Vercel project "tabs",
// which Vercel repoints at every production deployment. The project's team
// alias (tabs-<team>.vercel.app) serves the same deployment but is not
// canonical: the extension, sign-in and localStorage are all per-origin, so
// Hubble must be reached at exactly one of them. Never a per-deployment URL
// (tabs-<hash>-<team>.vercel.app), which dies with its deployment.
export const CANONICAL_PRODUCTION_ORIGIN = "https://hubble-hq.vercel.app";

// Origins that were once baked into shipped artifacts and must never be again.
// Resolving to one of these is a build failure, not a warning: an extension
// built against a dead or foreign origin installs cleanly and then fails only
// when a user clicks "Dump Tabs".
export const RETIRED_ORIGINS = Object.freeze({
  // The previous production alias. It was removed from the Vercel project and
  // now answers every request with 404 DEPLOYMENT_NOT_FOUND — extensions
  // packaged with it opened that error page on every dump.
  "https://tabsdump.vercel.app": "a removed Vercel alias that now returns 404 DEPLOYMENT_NOT_FOUND",
  // A one-letter lookalike of the above that belongs to an unrelated site.
  "https://tabdump.vercel.app": "an unrelated third-party site",
});

/**
 * Normalises `value` (a full URL or a bare host, as Vercel's env vars give it)
 * to an origin — scheme + host + port, no path, no trailing slash — and
 * refuses a retired one. Paths are dropped deliberately: the result becomes a
 * manifest match pattern (`${origin}/*`), where a path would silently narrow
 * which pages the content script attaches to.
 *
 * @param {string} value
 * @param {string} source where `value` came from, for the error message
 * @returns {string}
 */
function toOrigin(value, source) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let origin;
  try {
    origin = new URL(withScheme).origin;
  } catch {
    throw new Error(`${source} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (origin === "null") throw new Error(`${source} has no origin: ${JSON.stringify(value)}`);
  const retired = RETIRED_ORIGINS[origin];
  if (retired) {
    throw new Error(
      `${source} resolved to ${origin}, which is ${retired}. ` +
        `Point it at Hubble's live production origin instead (fallback: ${CANONICAL_PRODUCTION_ORIGIN}).`
    );
  }
  return origin;
}

/**
 * The origin a build should treat as "where Hubble lives", in precedence order:
 *
 *   1. TABDUMP_PRODUCTION_ORIGIN — an explicit override (e.g. a localhost ZIP
 *      for testing the download → load-unpacked flow end to end).
 *   2. VERCEL_URL on a Vercel *preview* build — that preview's own URL, so a
 *      preview's extension talks to the preview.
 *   3. VERCEL_PROJECT_PRODUCTION_URL on a Vercel *production* build — the
 *      project's production domain as Vercel itself has it configured.
 *      VERCEL_URL is ignored here on purpose: in production it is the
 *      per-deployment hash URL, which stops existing once that deployment is
 *      cleaned up.
 *   4. CANONICAL_PRODUCTION_ORIGIN.
 *
 * @param {Record<string, string | undefined>} env usually `process.env`
 * @returns {string}
 */
export function resolveProductionOrigin(env) {
  const explicit = env.TABDUMP_PRODUCTION_ORIGIN?.trim();
  if (explicit) return toOrigin(explicit, "TABDUMP_PRODUCTION_ORIGIN");

  const vercelUrl = env.VERCEL_URL?.trim();
  if (env.VERCEL_ENV === "preview" && vercelUrl) return toOrigin(vercelUrl, "VERCEL_URL");

  const productionUrl = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (env.VERCEL_ENV === "production" && productionUrl) {
    return toOrigin(productionUrl, "VERCEL_PROJECT_PRODUCTION_URL");
  }

  return CANONICAL_PRODUCTION_ORIGIN;
}

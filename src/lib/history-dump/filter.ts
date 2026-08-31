/**
 * First-pass, deterministic noise removal for History Dump (AGENTS.md
 * section 6). Deliberately conservative: this only strips things that are
 * near-certainly not a page worth reviewing (browser-internal URLs, auth/
 * checkout/search-result plumbing, blank/unparseable entries) — ordinary
 * content (Wikipedia, Reddit, YouTube, GitHub, docs, news, blogs, shopping
 * product pages, …) always survives this pass. Nothing here makes a
 * judgment about *importance* — that's score.ts's job, and it runs on
 * whatever this function lets through.
 */

const NON_WEB_SCHEMES = new Set([
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "edge-extension:",
  "moz-extension:",
  "extension:",
  "file:",
  "data:",
  "javascript:",
  "view-source:",
  "devtools:",
  "chrome-search:",
  "chrome-untrusted:",
]);

/**
 * Hostnames that are almost always an authentication hop, not a destination
 * page — identity providers and SSO endpoints a user "visits" only in transit
 * to somewhere else. Matched against the full hostname or as a suffix (e.g.
 * `accounts.google.com` and `login.microsoftonline.com`).
 */
const AUTH_HOSTNAME_PATTERNS = [
  /^accounts\./i,
  /^login\./i,
  /^signin\./i,
  /^auth\./i,
  /^sso\./i,
  /^id\./i,
  /^idp\./i,
];

/** Path segments that mark an auth/checkout/transactional step rather than content, wherever they occur on any site. */
const NOISE_PATH_PATTERNS = [
  /\/(log[-_]?in|sign[-_]?in|sign[-_]?up|sso|oauth2?|authorize|saml)(\/|$)/i,
  /\/auth\/(callback|redirect)(\/|$)/i,
  /\/(checkout|cart\/checkout|billing|payment[s]?)(\/|$)/i,
];

/** Search-results pages on the major engines — identifiable and near-universally not worth re-surfacing as a "page." */
const SEARCH_RESULT_HOSTS = new Set([
  "www.google.com",
  "google.com",
  "www.bing.com",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "www.ecosia.org",
]);
const SEARCH_RESULT_PATHS = new Set(["/search", "/html"]);

function isSearchResultPage(url: URL): boolean {
  if (!SEARCH_RESULT_HOSTS.has(url.hostname)) return false;
  return SEARCH_RESULT_PATHS.has(url.pathname) && (url.searchParams.has("q") || url.searchParams.has("p"));
}

/** Conservative exact-ish match — a title that *is* an error, not one that merely mentions the word. */
const ERROR_TITLE_PATTERN = /^(404|403|500|502|503)(\s|:|$)|^(page not found|access denied|forbidden|internal server error)$/i;

export function isNoiseUrl(rawUrl: string, title?: string): boolean {
  if (!rawUrl || !rawUrl.trim()) return true;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }

  if (NON_WEB_SCHEMES.has(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return true;

  if (AUTH_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname))) return true;
  if (NOISE_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) return true;
  if (isSearchResultPage(url)) return true;
  if (title && ERROR_TITLE_PATTERN.test(title.trim())) return true;

  return false;
}

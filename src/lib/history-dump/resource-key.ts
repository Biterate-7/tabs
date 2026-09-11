import { canonicalSiteIdentity } from "@/lib/organize/domain-identity";
import { TRACKING_PARAMS } from "@/lib/tabs/normalize";

/**
 * "Which underlying resource is this?" for a history URL — one step coarser
 * than `normalizeUrl` (src/lib/tabs/normalize.ts), which stays TabDump's
 * strict notion of "identical" and is what duplicate-flagging on save and
 * Auto-Organize rely on. This is History Dump's answer to a different
 * question: browsing history routinely records the *same page* under URLs
 * that normalizeUrl rightly keeps apart (`www.` vs bare host, http vs
 * https, `&t=120` on a YouTube link, a share `?si=` token), and reviewing
 * three rows for one video is the bug this module exists to prevent.
 *
 * Deliberately conservative, in this order of preference:
 *   1. Never drop a query parameter that could identify a different
 *      resource. Parameter handling is a *denylist* of known
 *      tracking/referral/playback junk, never an allowlist — `?v=`, `?id=`,
 *      `?page=`, `?q=` and everything else unknown always survive, so
 *      `watch?v=AAA` and `watch?v=BBB` stay two resources.
 *   2. Site-specific rules only where a site demonstrably addresses one
 *      resource many ways (YouTube's watch/shorts/embed/youtu.be forms).
 *   3. When in doubt, produce a *more* specific key — a key that is too
 *      specific merely fails to merge two rows, while one that is too loose
 *      silently discards a page the user wanted.
 */

/** Known referral/tracking/playback-position parameters — never resource-identifying on any site we know of. `TRACKING_PARAMS` is folded in so there is one list, not two. */
const NOISE_PARAMS = new Set<string>([
  ...TRACKING_PARAMS,
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "referer",
  "source",
  "cmpid",
  "ncid",
  "scid",
  "spm",
  "trk",
  "si",
  "feature",
  "share",
  "sharesource",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
  "__twitter_impression",
  // Google's own result-page plumbing, which rides along on copied links.
  "ved",
  "ei",
  "oq",
  "gs_lcp",
  "sourceid",
  "usqp",
  "sa",
]);

/** Any `utm_*` beyond the handful enumerated above (utm_id, utm_reader, utm_brand, …). */
const UTM_PREFIX = /^utm_/i;

function isNoiseParam(name: string): boolean {
  return NOISE_PARAMS.has(name.toLowerCase()) || UTM_PREFIX.test(name);
}

/** Canonical identities of every host that addresses the same YouTube video several ways. */
const YOUTUBE_HOSTS = new Set(["youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"]);

/** `/watch?v=ID`, `/shorts/ID`, `/embed/ID`, `/live/ID` and `youtu.be/ID` are all one video. `/playlist?list=ID` is its own resource. */
function youtubeResourcePath(host: string, segments: string[], params: URLSearchParams): string | null {
  if (host === "youtu.be") {
    return segments[0] ? `video/${segments[0]}` : null;
  }
  if (segments[0] === "watch") {
    const v = params.get("v");
    return v ? `video/${v}` : null;
  }
  if ((segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live") && segments[1]) {
    return `video/${segments[1]}`;
  }
  if (segments[0] === "playlist") {
    const list = params.get("list");
    return list ? `playlist/${list}` : null;
  }
  return null;
}

/** Index files and AMP variants address the page they sit in, not a distinct one. */
const INDEX_FILE = /^index\.(html?|php|jsp|aspx?)$/i;

function normalizePathSegments(pathname: string): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape sequence stays as-is rather than losing the path.
  }
  const segments = decoded.split("/").filter(Boolean);
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (INDEX_FILE.test(last) || last.toLowerCase() === "amp") segments.pop();
    else break;
  }
  return segments;
}

/**
 * Query parameters a given page uses to carry a *search query* rather than
 * to address a resource. Used both to build the key and by redundancy
 * scoring, which treats two searches of the same site as near-duplicates
 * far more readily than two ordinary pages.
 */
/** Deliberately excludes single-letter catch-alls like `p`, which WordPress uses as a post id — a resource, not a query. */
const QUERY_PARAMS = ["q", "query", "search_query", "search", "keyword", "keywords", "k", "wd"] as const;

/** Path segments that mark a search endpoint, so an ordinary article carrying a stray `?q=` highlight isn't mistaken for one. */
const SEARCH_PATH_SEGMENT = /^(search|results|find|s)$/i;

/**
 * The search query this URL runs, or `null` if it isn't a search page.
 * Requires *both* a non-empty query-ish parameter and a search-shaped path
 * (or a bare host, as `duckduckgo.com/?q=…` uses) — deliberately narrow,
 * since misreading a content page as a search page would make it eligible
 * for the much looser search-redundancy rule.
 */
export function searchQueryOf(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const looksLikeSearch = segments.length === 0 || segments.some((s) => SEARCH_PATH_SEGMENT.test(s));
  if (!looksLikeSearch) return null;

  for (const name of QUERY_PARAMS) {
    const value = url.searchParams.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * A stable key for the resource a URL points at. Two history entries sharing
 * one are the same page and should never both be reviewed, let alone both
 * dumped. Accepts a raw or already-normalized URL; anything unparseable is
 * returned trimmed and lowercased so it still groups with itself rather
 * than throwing.
 */
export function canonicalResourceKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  const host = canonicalSiteIdentity(url.hostname);
  const segments = normalizePathSegments(url.pathname);

  if (YOUTUBE_HOSTS.has(host)) {
    const youtubePath = youtubeResourcePath(host, segments, url.searchParams);
    if (youtubePath) return `youtube.com/${youtubePath}`;
  }

  const params: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (isNoiseParam(name)) continue;
    params.push([name, value]);
  }
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const search = params.map(([name, value]) => `${name}=${value}`).join("&");
  const path = segments.length > 0 ? `/${segments.join("/")}` : "";

  return `${host}${path}${search ? `?${search}` : ""}`;
}

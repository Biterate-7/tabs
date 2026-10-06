import { youtubeVideoId } from "./detect";

/**
 * The identity of a source's address: two URLs with the same key are the
 * same source, so adding the second is a duplicate, not a new resource.
 *
 * ## What is folded together
 *
 *   - scheme and `www.`/`m.` host prefixes (http://www.x.com/a ≡ https://x.com/a)
 *   - letter case of the host
 *   - the fragment (#section)
 *   - a trailing slash on the path
 *   - percent-encoding of characters that never needed it (%7E ≡ ~)
 *   - known tracking parameters (utm_*, fbclid, gclid, …)
 *   - query parameter order
 *   - every YouTube address shape for one video — watch, youtu.be, shorts,
 *     embed, live, mobile — including share (`si`) and start-time (`t`)
 *     parameters, since a timestamp is a place in the same video
 *
 * ## What is never touched
 *
 * Every other query parameter. `?id=7` and `?id=8` are different documents
 * on most sites, and a key that dropped them would merge distinct sources.
 * The path's case is kept too: paths are case-sensitive on most servers.
 *
 * The key is for comparison only. The URL a person added is the one stored
 * and opened.
 */

const TRACKING = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "ref_src",
  "ref_url",
  "spm",
  "si",
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING.has(lower);
}

/** Decodes only the unreserved characters (RFC 3986 §2.3), which are equal encoded or not. */
function normalizeEncoding(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

export function resourceKey(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const video = youtubeVideoId(url);
  if (video) return `youtube:${video}`;

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  const path = normalizeEncoding(url.pathname).replace(/\/+$/, "") || "";
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${port}${path}${query}`;
}

/** Whether two addresses are the same source. Malformed input is never the same as anything. */
export function sameResource(a: string, b: string): boolean {
  const left = resourceKey(a);
  return left !== undefined && left === resourceKey(b);
}

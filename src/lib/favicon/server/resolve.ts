import "server-only";
import { faviconHostKey } from "../host";
import { discoverIcons } from "./discover";
import { createSafeFetcher, type SafeFetchResult, type SafeFetcher } from "./safe-fetch";
import { sniffIconType } from "./sniff";

/**
 * host → the site's own favicon bytes, or a definite "none".
 *
 * Order, and why:
 *
 * 1. Fetch the site's home page and read its <link rel="icon"> /
 *    apple-touch-icon declarations (./discover.ts). That is what a browser
 *    shows, and it is often not /favicon.ico.
 * 2. Try `/favicon.ico` on the site itself — the convention every browser
 *    falls back to, and all a login-walled app like console.cloud.google.com
 *    exposes to a signed-out fetch (its /favicon.ico redirects to the
 *    console icon on ssl.gstatic.com).
 *
 * When the home page redirects to a *different* host (console → the
 * accounts.google.com sign-in page), the icons that page declares are the
 * sign-in page's, not the site's, so /favicon.ico goes first in that case.
 *
 * Each candidate must come back 200 AND sniff as a real image; a soft-404
 * HTML page or a placeholder is skipped rather than accepted.
 */

export type FaviconResolution =
  | { ok: true; body: Buffer; contentType: string; source: string }
  | { ok: false; reason: "invalid-host" | "not-found" | "unreachable" };

const PAGE_MAX_BYTES = 512 * 1024;
const ICON_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4000;
/** Candidates tried per host, so one site with dozens of <link>s can't fan out. */
const MAX_ICON_ATTEMPTS = 5;

const HEAD_END = /<\/head\s*>|<body[\s>]/i;

/** Statuses that mean "turned away" (auth, bot walls, rate limits, outages), not "nothing here". */
const INCONCLUSIVE_STATUS = (status: number) =>
  status === 401 || status === 403 || status === 407 || status === 429 || status >= 500;

let defaultFetcher: SafeFetcher | null = null;

function decodeDataUrl(url: string): Buffer | null {
  const match = url.match(/^data:([^,]*?)(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  try {
    const body = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return body.length > 0 && body.length <= ICON_MAX_BYTES ? body : null;
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  const strip = (host: string) => host.replace(/^www\./, "");
  return strip(a) === strip(b);
}

export async function resolveFavicon(
  host: string,
  options: { fetcher?: SafeFetcher; signal?: AbortSignal } = {}
): Promise<FaviconResolution> {
  const key = faviconHostKey(host);
  if (!key) return { ok: false, reason: "invalid-host" };

  const fetcher = options.fetcher ?? (defaultFetcher ??= createSafeFetcher());
  const signal = options.signal;

  // "not-found" is a promise that the site itself was asked and has no icon,
  // which tells the client not to bother trying it directly. Anything short
  // of a clear answer — a bot wall's 403, a 5xx, a timeout — makes the miss
  // "unreachable" instead: the server was turned away, but the user's own
  // browser may not be.
  let conclusive = true;
  const record = (result: SafeFetchResult) => {
    if (result.ok ? INCONCLUSIVE_STATUS(result.status) : result.reason !== "no-such-host") conclusive = false;
  };

  // The page, over https first. `Tab.domain` drops "www.", so a site that only
  // answers on www. is retried there; plain http is the last resort for the
  // few sites with no TLS at all.
  const origins = [`https://${key}`, ...(key.startsWith("www.") ? [] : [`https://www.${key}`]), `http://${key}`];
  let siteOrigin = origins[0];
  let page: SafeFetchResult | null = null;
  const pageFailures: SafeFetchResult[] = [];
  for (const origin of origins) {
    if (signal?.aborted) break;
    const attempt = await fetcher(`${origin}/`, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      maxBytes: PAGE_MAX_BYTES,
      onOverflow: "truncate",
      stopWhen: (body) => HEAD_END.test(body.toString("latin1")),
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal,
    });
    // A blocked host is blocked on every origin; an HTTP error is still an answer.
    if (attempt.ok || attempt.reason === "blocked") {
      page = attempt;
      siteOrigin = origin;
      break;
    }
    pageFailures.push(attempt);
  }

  if (!page) {
    // No name resolves at all: the domain doesn't exist, which is an answer.
    const nonexistent = pageFailures.length === origins.length && pageFailures.every((f) => !f.ok && f.reason === "no-such-host");
    return { ok: false, reason: nonexistent ? "not-found" : "unreachable" };
  }
  if (!page.ok) return { ok: false, reason: "unreachable" };
  record(page);

  let declared: string[] = [];
  let declaredOnSite = true;
  if (page.status >= 200 && page.status < 300 && /html|xml/i.test(page.contentType || "text/html")) {
    declared = discoverIcons(page.body.toString("utf8"), page.url).map((icon) => icon.url);
    declaredOnSite = sameSite(new URL(page.url).hostname, key);
  }

  const conventional = `${siteOrigin}/favicon.ico`;
  const candidates = [...new Set(declaredOnSite ? [...declared, conventional] : [conventional, ...declared])].slice(
    0,
    MAX_ICON_ATTEMPTS
  );

  for (const candidate of candidates) {
    if (signal?.aborted) {
      conclusive = false;
      break;
    }

    if (candidate.startsWith("data:")) {
      const body = decodeDataUrl(candidate);
      const contentType = body && sniffIconType(body);
      if (body && contentType) return { ok: true, body, contentType, source: "inline" };
      continue;
    }

    const response = await fetcher(candidate, {
      accept: "image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.8,*/*;q=0.1",
      maxBytes: ICON_MAX_BYTES,
      onOverflow: "fail",
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal,
    });
    record(response);
    if (!response.ok || response.status !== 200) continue;
    const contentType = sniffIconType(response.body);
    if (contentType) return { ok: true, body: response.body, contentType, source: response.url };
  }

  return { ok: false, reason: conclusive ? "not-found" : "unreachable" };
}

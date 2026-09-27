import { apiOrigin } from "@/lib/platform/api-base";
import { isDesktop } from "@/lib/platform/detect";
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";
import { faviconHostKey } from "./host";

/**
 * Every favicon Hubble draws — tab cards, peeks, dialogs, graph nodes —
 * comes through here, keyed by `faviconHostKey(domain)`. React reads it
 * through src/hooks/use-favicon-src.ts; the graph canvas reads it directly.
 *
 * Sources, in order:
 *
 * 1. Hubble's own resolver, `/api/favicon?host=…` (src/app/api/favicon),
 *    read with fetch(). It reads the site's declared icons and /favicon.ico
 *    server-side, where cross-origin HTML is readable, and answers with
 *    verified image bytes or a JSON miss that says why — never a
 *    placeholder image that would "load" successfully. The bytes become a
 *    `blob:` URL, so each host costs one request however many cards, peeks
 *    and graph nodes draw it, and a miss is not a failed resource load.
 * 2. Web only, and only when the resolver could not reach the site (a bot
 *    wall, a region block — not "reached it, no icon"): the site's
 *    `/favicon.ico`, loaded directly by the browser. An <img> needs no CORS,
 *    and nothing here reads its pixels.
 *
 * The platform boundary: the desktop build has no API routes (it is a
 * static export), so it fetches the deployed resolver cross-origin (the
 * route sends `Access-Control-Allow-Origin: *`; the CSP's connect-src
 * already allows the production origin) and skips (2), which would need a
 * wildcard img-src.
 *
 * Caching, three layers:
 * - Here, in memory: one request per host per page load, shared by every
 *   component and the canvas. A failure is remembered for FAILURE_RETRY_MS
 *   only — and never persisted — so it can't poison later sessions.
 * - The browser's HTTP cache, from the route's Cache-Control: a reload
 *   re-renders icons without re-requesting them.
 * - The CDN in front of the route, shared across users.
 */

type Entry =
  | { state: "loading" }
  | { state: "ready"; src: string; image: HTMLImageElement }
  | { state: "missing"; retryAt: number };

/** How long a host that produced no icon is left alone before the next mount may try again. */
export const FAILURE_RETRY_MS = 10 * 60 * 1000;
/** A source that has neither loaded nor failed by now is treated as failed. */
export const SOURCE_TIMEOUT_MS = 15_000;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Where the resolver lives: same-origin on the web, the deployed site from the desktop app. */
function faviconServiceOrigin(platform: "web" | "desktop"): string {
  return apiOrigin() || (platform === "desktop" ? CANONICAL_PRODUCTION_ORIGIN : "");
}

/** Where `host`'s icon is looked up: the resolver, and the direct fallback where the platform allows one. */
export function faviconSources(host: string, platform: "web" | "desktop"): { service: string; direct: string | null } {
  return {
    service: `${faviconServiceOrigin(platform)}/api/favicon?host=${encodeURIComponent(host)}`,
    direct: platform === "desktop" ? null : `https://${host}/favicon.ico`,
  };
}

/** Decodes `src` as an image; null if it fails or takes longer than SOURCE_TIMEOUT_MS. */
function probe(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let finished = false;
    const finish = (result: HTMLImageElement | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(null);
      image.src = "";
    }, SOURCE_TIMEOUT_MS);
    image.decoding = "async";
    // The site learns nothing about where its icon is being displayed.
    image.referrerPolicy = "no-referrer";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = src;
  });
}

type ServiceAnswer = { icon: { src: string; image: HTMLImageElement } } | { miss: "not-found" | "unreachable" };

async function askService(url: string): Promise<ServiceAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: "omit", signal: controller.signal });
    // A resolver that is down or refused the request says nothing about the site.
    if (!response.ok) return { miss: "unreachable" };

    if ((response.headers.get("content-type") ?? "").startsWith("image/")) {
      const src = URL.createObjectURL(await response.blob());
      const image = await probe(src);
      if (image) return { icon: { src, image } };
      URL.revokeObjectURL(src);
      // Verified bytes this browser can't decode: the same file would fail directly too.
      return { miss: "not-found" };
    }

    const body = (await response.json().catch(() => null)) as { reason?: string } | null;
    return { miss: body?.reason === "not-found" ? "not-found" : "unreachable" };
  } catch {
    return { miss: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function load(host: string): Promise<void> {
  const { service, direct } = faviconSources(host, isDesktop() ? "desktop" : "web");
  const answer = await askService(service);

  if ("icon" in answer) {
    entries.set(host, { state: "ready", ...answer.icon });
  } else {
    const image = answer.miss === "unreachable" && direct ? await probe(direct) : null;
    entries.set(
      host,
      image ? { state: "ready", src: direct!, image } : { state: "missing", retryAt: Date.now() + FAILURE_RETRY_MS }
    );
  }
  notify();
}

/** Releases what an entry holds before it is replaced or dropped. */
function release(entry: Entry | undefined) {
  if (entry?.state === "ready" && entry.src.startsWith("blob:")) URL.revokeObjectURL(entry.src);
}

/**
 * Starts resolving `domain`'s icon unless it is already loaded, loading, or
 * failed recently. Cheap and idempotent — call it from every effect/frame
 * that wants the icon, then read the result with the peek functions.
 * Must not be called during render: it consults the platform.
 */
export function requestFavicon(domain: string): void {
  const host = faviconHostKey(domain);
  if (!host) return;
  const entry = entries.get(host);
  if (entry && (entry.state !== "missing" || Date.now() < entry.retryAt)) return;
  entries.set(host, { state: "loading" });
  void load(host);
}

/** The loaded icon's URL, or null while loading, after a failure, or for a host with no lookup. */
export function peekFaviconSrc(domain: string): string | null {
  const host = faviconHostKey(domain);
  const entry = host ? entries.get(host) : undefined;
  return entry?.state === "ready" ? entry.src : null;
}

/** The decoded image itself, for canvas drawing. */
export function peekFaviconImage(domain: string): HTMLImageElement | null {
  const host = faviconHostKey(domain);
  const entry = host ? entries.get(host) : undefined;
  return entry?.state === "ready" ? entry.image : null;
}

/**
 * An <img> showing `src` failed after the probe succeeded (a direct icon
 * that changed or vanished, or a revoked blob). Forget it, so every other
 * view falls back too and the next request starts over.
 */
export function reportFaviconBroken(domain: string, src: string): void {
  const host = faviconHostKey(domain);
  const entry = host ? entries.get(host) : undefined;
  if (!host || entry?.state !== "ready" || entry.src !== src) return;
  release(entry);
  entries.set(host, { state: "missing", retryAt: Date.now() + FAILURE_RETRY_MS });
  notify();
}

export function subscribeFavicons(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget everything. */
export function resetFaviconCache(): void {
  for (const entry of entries.values()) release(entry);
  entries.clear();
  notify();
}

// Failures while offline say nothing about the sites; retry them on reconnect.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    let changed = false;
    for (const [host, entry] of entries) {
      if (entry.state === "missing") {
        entries.delete(host);
        changed = true;
      }
    }
    if (changed) notify();
  });
}

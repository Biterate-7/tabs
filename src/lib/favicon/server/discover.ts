import { decodeEntities } from "@/lib/titles/server/resolvers/generic";

/**
 * Finds the icons a page declares for itself, best first.
 *
 * Declared icons are what a browser actually shows in its tab strip, and
 * they are frequently NOT at /favicon.ico — hashed asset paths
 * (`/favicon.ico?favicon.38e20fl.ico` on this very app), CDN hosts, SVG
 * icons, or a path under a subdirectory. So the resolver asks the page
 * first and falls back to /favicon.ico, the same order browsers use.
 */

export type DeclaredIcon = {
  /** Absolute http(s) URL or a `data:` URL, already resolved against the page (and any <base href>). */
  url: string;
  rel: "icon" | "apple-touch-icon";
  /** Largest declared edge in px; Infinity for `sizes="any"` or an SVG (scalable). Undefined when undeclared. */
  size?: number;
};

/** The largest size an icon is displayed at, times a 2x display. */
const IDEAL_SIZE = 64;
/** Anything smaller than this upscales visibly at 28px. */
const MIN_SHARP_SIZE = 32;

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<[a-z]+/i, "").replace(/\/?>$/, "");
  for (const match of body.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function iconRel(rel: string): DeclaredIcon["rel"] | null {
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  // "shortcut icon" is the legacy spelling of "icon"; mask-icon and fluid-icon are monochrome/app-specific.
  if (tokens.includes("icon")) return "icon";
  if (tokens.includes("apple-touch-icon") || tokens.includes("apple-touch-icon-precomposed")) return "apple-touch-icon";
  return null;
}

function declaredSize(sizes: string | undefined, type: string | undefined, url: string): number | undefined {
  if (type?.toLowerCase().includes("svg") || /\.svg(?:[?#]|$)/i.test(url)) return Infinity;
  if (!sizes) return undefined;
  if (/\bany\b/i.test(sizes)) return Infinity;
  const edges = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((m) => Math.max(Number(m[1]), Number(m[2])));
  return edges.length > 0 ? Math.max(...edges) : undefined;
}

/** Lower is better: sharp enough first, then closest to the ideal size, unknown sizes in between. */
function sizePenalty(size: number | undefined): number {
  if (size === undefined) return 1;
  if (size === Infinity) return 0;
  if (size >= MIN_SHARP_SIZE) return Math.abs(size - IDEAL_SIZE) / 1000;
  return 2 + (MIN_SHARP_SIZE - size) / 100;
}

function resolveHref(href: string, base: URL): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * `html` may be truncated; only the head matters. `pageUrl` must be the URL
 * the HTML was finally served from (after redirects), since that — not the
 * URL first asked for — is what relative hrefs are relative to.
 */
export function discoverIcons(html: string, pageUrl: string): DeclaredIcon[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  // Link tags inside comments or scripts are not declarations.
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = (headEnd === -1 ? html : html.slice(0, headEnd))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");

  const baseTag = head.match(/<base\b[^>]*>/i);
  if (baseTag) {
    const href = parseAttributes(baseTag[0]).get("href");
    if (href) {
      try {
        base = new URL(href, base);
      } catch {
        // An unparsable <base> is ignored, as browsers do.
      }
    }
  }

  const found: (DeclaredIcon & { order: number })[] = [];
  for (const [order, match] of [...head.matchAll(/<link\b[^>]*>/gi)].entries()) {
    const attributes = parseAttributes(match[0]);
    const rel = iconRel(attributes.get("rel") ?? "");
    if (!rel) continue;
    const url = resolveHref(attributes.get("href") ?? "", base);
    if (!url) continue;
    found.push({ url, rel, size: declaredSize(attributes.get("sizes"), attributes.get("type"), url), order });
  }

  // rel=icon always beats apple-touch-icon: touch icons are drawn for home
  // screens (opaque backgrounds, padding) and are only a fallback here.
  found.sort(
    (a, b) =>
      Number(a.rel !== "icon") - Number(b.rel !== "icon") ||
      sizePenalty(a.size) - sizePenalty(b.size) ||
      a.order - b.order
  );

  const seen = new Set<string>();
  return found
    .filter((icon) => (seen.has(icon.url) ? false : (seen.add(icon.url), true)))
    .map(({ url, rel, size }) => (size === undefined ? { url, rel } : { url, rel, size }));
}

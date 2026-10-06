/**
 * A web page's readable text and metadata, from its HTML — without a DOM, so
 * the same code runs on the server (where pages are fetched) and in tests.
 *
 * Deliberately modest. It removes what is obviously not the article —
 * scripts, styles, navigation, headers, footers, sidebars, forms — prefers
 * an `<article>` (or `<main>`) when the page marks one, and keeps paragraph
 * breaks so an agent can quote a passage. It does not try to be a reader
 * mode; a page it reads badly still yields its title, address and whatever
 * text survived, and the status says what was read.
 *
 * Everything returned is page-authored and therefore untrusted. It is never
 * interpreted here, and the context layer frames it as source material.
 */

export type ReadablePage = {
  title?: string;
  text: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  description?: string;
};

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}

function meta(html: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
    const forward = new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, "i");
    const reverse = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\\s*=\\s*["']${escaped}["']`, "i");
    const match = html.match(forward) ?? html.match(reverse);
    const value = match?.[1] ? decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim() : "";
    if (value) return value;
  }
  return undefined;
}

const DROP_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "header", "footer", "aside", "form", "button", "select", "figure"];
/** A tag's attributes, including quoted values that themselves contain ">" (Wikipedia's data-mw JSON does). */
const ATTRIBUTES = `[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*`;
const ANY_TAG = new RegExp(`<\\/?[A-Za-z]${ATTRIBUTES}>`, "g");
const BLOCK_TAGS = new RegExp(`<\\/?(?:p|div|section|article|main|br|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|hr)\\b${ATTRIBUTES}>`, "gi");

function largest(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let best: string | undefined;
  for (const match of html.matchAll(pattern)) if (!best || match[1]!.length > best.length) best = match[1];
  return best;
}

export function htmlToText(fragment: string): string {
  let html = fragment.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_BLOCKS) html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  // Elements the page itself hides or marks as chrome.
  html = html.replace(/<(\w+)\b[^>]*\b(?:hidden|aria-hidden\s*=\s*["']true["']|role\s*=\s*["'](?:navigation|banner|contentinfo)["'])[^>]*>[\s\S]*?<\/\1>/gi, " ");
  html = html.replace(BLOCK_TAGS, "\n").replace(ANY_TAG, " ");
  const lines = decodeHtmlEntities(html)
    .split("\n")
    .map((line) => line.replace(/[\s ]+/g, " ").trim())
    .filter((line) => line.length > 1);
  const out: string[] = [];
  for (const line of lines) if (out[out.length - 1] !== line) out.push(line);
  return out.join("\n");
}

export function readHtml(html: string): ReadablePage {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = meta(html, ["og:title", "twitter:title"]) ?? (titleTag ? decodeHtmlEntities(titleTag).replace(/\s+/g, " ").trim() : undefined);
  const body = largest(html, "article") ?? largest(html, "main") ?? largest(html, "body") ?? html;
  const timeAttr = html.match(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i)?.[1];
  const page: ReadablePage = { text: htmlToText(body) };
  if (title) page.title = title;
  const siteName = meta(html, ["og:site_name", "application-name"]);
  const author = meta(html, ["author", "article:author", "citation_author", "dc.creator", "parsely-author"]);
  const publishedAt = meta(html, ["article:published_time", "citation_publication_date", "dc.date", "date", "datePublished"]) ?? timeAttr;
  const description = meta(html, ["og:description", "description", "twitter:description"]);
  if (siteName) page.siteName = siteName.slice(0, 200);
  if (author && !/^https?:/i.test(author)) page.author = author.slice(0, 200);
  if (publishedAt) page.publishedAt = publishedAt.slice(0, 60);
  if (description) page.description = description.slice(0, 500);
  return page;
}

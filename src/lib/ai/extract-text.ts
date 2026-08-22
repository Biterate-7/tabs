import "server-only";
import { fetchHtmlCapped, decodeEntities } from "@/lib/titles/server/resolvers/generic";

const MAX_TEXT_CHARS = 1500;
const FETCH_TIMEOUT_MS = 8000;

export type ExtractedContent = {
  description?: string;
  text?: string;
};

const DESCRIPTION_PATTERNS = [
  /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
  /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
  /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
];

function extractMetaDescription(html: string): string | undefined {
  for (const pattern of DESCRIPTION_PATTERNS) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]).trim();
  }
  return undefined;
}

/** Crude but dependency-free HTML→text: drop non-content tags, then every tag. */
function stripToText(html: string): string {
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutNonContent.replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/**
 * Best-effort page content for AI indexing, reusing the same capped/SSRF-safe
 * fetch path the title resolver uses. Returns null rather than throwing for
 * anything unfetchable/non-HTML — the indexer just falls back to
 * title/url/category for that tab.
 */
export async function extractPageContent(url: string): Promise<ExtractedContent | null> {
  const fetched = await fetchHtmlCapped(url, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  if (!fetched.ok) return null;
  if (fetched.status < 200 || fetched.status >= 300) return null;
  if (!fetched.contentType.includes("html")) return null;

  const description = extractMetaDescription(fetched.html);
  const text = stripToText(fetched.html).slice(0, MAX_TEXT_CHARS) || undefined;

  if (!description && !text) return null;
  return { description, text };
}

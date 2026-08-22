import "server-only";
import type { ResolverContext, ResolverResult, TitleResolver } from "@/lib/titles/types";

const MAX_BYTES = 65536;
const FETCH_TIMEOUT_MS = 5000;

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITY_MAP[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractMetaContent(html: string, attr: "property" | "name", value: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  const reversed = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${value}["']`,
    "i"
  );
  const match = html.match(pattern) ?? html.match(reversed);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : null;
}

async function readCappedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return text;
}

export async function extractTitleFromHtml(html: string): Promise<string | null> {
  return extractMetaContent(html, "property", "og:title") ??
    extractMetaContent(html, "name", "twitter:title") ??
    extractTitleTag(html);
}

export type CappedFetchResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; html: string }
  | { ok: false; reason: "timeout" | "network-error" };

/**
 * Shared by every resolver that needs raw HTML (generic, Google Docs): follows
 * redirects, applies one timeout, and stops reading after MAX_BYTES so a huge
 * or slow-drip response can't stall or balloon memory for the whole batch.
 */
export async function fetchHtmlCapped(url: string, signal: AbortSignal): Promise<CappedFetchResult> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: combined,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; TabDumpBot/1.0; +https://tabdump.example/bot)",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network-error" };
  }

  const html = await readCappedText(response);
  return {
    ok: true,
    finalUrl: response.url || url,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    html,
  };
}

export const genericResolver: TitleResolver = {
  id: "generic",
  canHandle(): boolean {
    return true;
  },
  async resolve(ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const fetched = await fetchHtmlCapped(ctx.url, signal);
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason, permanent: false };
    }

    if (fetched.status === 401 || fetched.status === 403) {
      return { ok: false, reason: "auth-required", permanent: false };
    }
    if (fetched.status === 404 || fetched.status === 410) {
      return { ok: false, reason: "not-found", permanent: true };
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      return { ok: false, reason: "blocked", permanent: false };
    }

    if (!fetched.contentType.includes("html")) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    const title = await extractTitleFromHtml(fetched.html);
    if (!title) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    return { ok: true, title, source: "generic" };
  },
};

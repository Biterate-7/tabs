import "server-only";
import type { ResolverContext, ResolverResult, TitleResolver } from "@/lib/titles/types";

const FETCH_TIMEOUT_MS = 5000;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

function extractVideoId(ctx: ResolverContext): string | null {
  if (ctx.hostname === "youtu.be") {
    const id = ctx.pathname.replace(/^\/+/, "");
    return id.length > 0 ? id : null;
  }

  if (YOUTUBE_HOSTS.has(ctx.hostname)) {
    if (ctx.pathname === "/watch") {
      const id = new URL(ctx.url).searchParams.get("v");
      return id && id.length > 0 ? id : null;
    }
    const shortsMatch = ctx.pathname.match(/^\/shorts\/([^/]+)/);
    if (shortsMatch) return shortsMatch[1];
  }

  return null;
}

/**
 * Uses YouTube's public, keyless oEmbed endpoint instead of scraping the
 * watch page's HTML — a purpose-built API is more reliable than parsing a
 * heavily-JS-driven page, and this is the concrete proof that the registry
 * isn't just "HTML scraping with extra steps."
 */
export const youtubeOEmbedResolver: TitleResolver = {
  id: "youtube-oembed",
  canHandle(ctx: ResolverContext): boolean {
    return extractVideoId(ctx) !== null;
  },
  async resolve(ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const videoId = extractVideoId(ctx);
    if (!videoId) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetch(oembedUrl, { signal: combined });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return { ok: false, reason: "timeout", permanent: false };
      }
      return { ok: false, reason: "network-error", permanent: false };
    }

    if (response.status === 404 || response.status === 401) {
      // Video removed, made private, or age/region restricted from oEmbed's view.
      return { ok: false, reason: "not-found", permanent: true };
    }
    if (!response.ok) {
      return { ok: false, reason: "blocked", permanent: false };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, reason: "no-title", permanent: true };
    }

    const title = (data as { title?: unknown } | null)?.title;
    if (typeof title !== "string" || title.trim().length === 0) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    return { ok: true, title: title.trim(), source: "youtube-oembed" };
  },
};

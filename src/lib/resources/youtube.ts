import { youtubeVideoId } from "./detect";

/**
 * A YouTube address, understood: which video, and where in it the address
 * starts — and the addresses Hubble builds to take someone to a moment.
 *
 * ## Two different times
 *
 * An address someone saved can carry its own start time (`?t=120`, a share
 * link "from 2:00"). A search result carries the time a transcript line is
 * said. They are never mixed: `startSeconds` is only ever read from the
 * saved address, and `youtubeMomentUrl` is always built from the video id
 * alone plus the moment asked for — so opening "8:42" from search lands at
 * 8:42, whatever the saved link said.
 *
 * Every address built here is rebuilt from the 11-character id, never from
 * the input string, so nothing a person pasted (credentials, odd hosts,
 * extra parameters) is carried into a link or a request.
 */

export type YouTubeShape = "watch" | "short" | "embed" | "live" | "share";

export type YouTubeAddress = {
  videoId: string;
  shape: YouTubeShape;
  /** The saved address's own start time, in whole seconds. */
  startSeconds?: number;
};

/** Longer than any video YouTube hosts; a bigger "start" is not a time. */
const MAX_SECONDS = 48 * 3600;

/**
 * A start-time parameter in the forms YouTube writes and accepts:
 * `120`, `120s`, `2m`, `2m3s`, `1h2m3s`. Anything else is not a time.
 */
export function parseTimeParam(value: string | null | undefined): number | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  let seconds: number;
  if (/^\d+s?$/.test(text)) seconds = Number.parseInt(text, 10);
  else {
    const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
    seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_SECONDS ? seconds : undefined;
}

function shapeOf(url: URL): YouTubeShape {
  if (url.hostname.toLowerCase().replace(/^www\./, "") === "youtu.be") return "share";
  const first = url.pathname.split("/")[1];
  if (first === "shorts") return "short";
  if (first === "embed" || first === "v") return "embed";
  if (first === "live") return "live";
  return "watch";
}

/** A YouTube video address, or `undefined` for anything else — another site, a channel page, a malformed id, a non-web scheme. */
export function parseYouTubeUrl(input: string): YouTubeAddress | undefined {
  if (typeof input !== "string" || input.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const videoId = youtubeVideoId(url);
  if (!videoId) return undefined;
  // `t` on watch and share links, `start` on embeds; a `#t=` fragment on older links.
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const startSeconds = parseTimeParam(url.searchParams.get("t")) ?? parseTimeParam(url.searchParams.get("start")) ?? parseTimeParam(fragment.get("t"));
  return { videoId, shape: shapeOf(url), ...(startSeconds !== undefined ? { startSeconds } : {}) };
}

function wholeSeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 1) return undefined;
  return Math.min(Math.floor(seconds), MAX_SECONDS);
}

/**
 * The video on YouTube at a moment. Always the watch page: it plays
 * standard videos, Shorts and past live streams alike, and is the one shape
 * that honours `t` for all of them.
 */
export function youtubeMomentUrl(videoId: string, seconds?: number): string {
  const at = wholeSeconds(seconds);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${at ? `&t=${at}s` : ""}`;
}

/**
 * The privacy-enhanced player (no cookies until the person presses play),
 * with the JS API on so Hubble can seek it and hear where it is. `origin`
 * is required by the player for that messaging.
 */
export function youtubeEmbedUrl(videoId: string, options: { start?: number; origin?: string } = {}): string {
  const params = new URLSearchParams({ enablejsapi: "1", rel: "0", playsinline: "1" });
  const start = wholeSeconds(options.start);
  if (start) params.set("start", String(start));
  if (options.origin) params.set("origin", options.origin);
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

/** YouTube's own still for a video. Deterministic from the id, so nothing needs storing. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

/** Where a player's messages come from — the only origins Hubble listens to. */
export const YOUTUBE_PLAYER_ORIGINS: readonly string[] = ["https://www.youtube-nocookie.com", "https://www.youtube.com"];

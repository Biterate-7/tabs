import "server-only";
import { cleanLanguageTag, normalizeTranscript } from "@/lib/resources/transcript";
import { youtubeMomentUrl } from "@/lib/resources/youtube";
import { readCapped } from "./fetch";
import type { TranscriptSegment } from "@/lib/resources/types";

/**
 * Getting a YouTube video's existing captions on the server.
 *
 * ## Why a provider, and why it is optional
 *
 * YouTube publishes no API that serves captions for videos you do not own
 * (the Data API's `captions.download` needs the owner's OAuth grant), and
 * fetching them straight from YouTube from a cloud host means getting past
 * its bot checks — which Hubble does not do. So transcripts come from a
 * reader service behind a server-side key, or not at all:
 *
 *   SUPADATA_API_KEY   set   → captions are fetched (`mode=native`: the
 *                              video's own captions only — never speech
 *                              recognition, never the audio)
 *                      unset → `not_configured`; the video is saved with
 *                              its metadata and says so honestly
 *
 * The key never leaves the server: it is read here, sent only to the
 * provider's fixed address, and never logged.
 *
 * ## What is sent, and to where
 *
 * Only the video's public watch address, rebuilt from its validated
 * 11-character id — never the address the person pasted, never anything
 * about them. The request goes to one fixed host with redirects refused,
 * so it cannot be turned into a fetch of anything else.
 *
 * ## Not asking twice
 *
 * Answers are kept in memory per server instance (a found transcript for a
 * day, "no captions" for a few hours; transient failures not at all), and
 * concurrent requests for one video share one call. The durable copy is the
 * person's own: the browser stores the transcript in IndexedDB and never
 * asks again for a video it has.
 */

export type TranscriptFetch =
  | { ok: true; segments: TranscriptSegment[]; language?: string; provider: string }
  | {
      ok: false;
      reason:
        | "not_configured" // no provider on this server, or it rejected the key
        | "no_captions" // the video exists and has no captions to read
        | "not_found" // private, removed, or not a video the provider can see
        | "rate_limited" // the provider's quota or rate limit, for now
        | "timeout"
        | "unreachable"
        | "malformed"; // an answer that was not a transcript
    };

export type TranscriptProvider = {
  id: string;
  fetchTranscript: (videoId: string, options: { language?: string; signal: AbortSignal }) => Promise<TranscriptFetch>;
};

export const TRANSCRIPT_LIMITS = {
  timeoutMs: 20_000,
  /** A 10-hour stream's captions are a few megabytes of JSON. */
  responseBytes: 8 * 1024 * 1024,
  /** Segments kept from one answer; the content store bounds again. */
  segments: 20_000,
} as const;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// ─── Supadata ──────────────────────────────────────────────────────────────

const SUPADATA_ENDPOINT = "https://api.supadata.ai/v1/transcript";

type SupadataChunk = { text?: unknown; offset?: unknown; duration?: unknown; lang?: unknown };

function readSupadata(body: unknown): TranscriptFetch {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed" };
  const record = body as { content?: unknown; lang?: unknown };
  if (!Array.isArray(record.content)) return { ok: false, reason: "malformed" };
  const raw = (record.content as SupadataChunk[]).slice(0, TRANSCRIPT_LIMITS.segments).map((chunk) => {
    const offset = typeof chunk?.offset === "number" ? chunk.offset : undefined;
    const duration = typeof chunk?.duration === "number" && chunk.duration > 0 ? chunk.duration : undefined;
    return {
      text: chunk?.text,
      ...(offset !== undefined ? { start: offset / 1000 } : {}),
      ...(offset !== undefined && duration !== undefined ? { end: (offset + duration) / 1000 } : {}),
    };
  });
  // Every chunk unusable (no text, no times) is a malformed answer, not an empty transcript.
  if (raw.length > 0 && raw.every((chunk) => typeof chunk.text !== "string")) return { ok: false, reason: "malformed" };
  const segments = normalizeTranscript(raw);
  if (segments.length === 0) return { ok: false, reason: "no_captions" };
  const language = cleanLanguageTag(record.lang);
  return { ok: true, segments, provider: "supadata", ...(language ? { language } : {}) };
}

export function supadataProvider(options: { apiKey: string; fetcher?: typeof fetch }): TranscriptProvider {
  const fetcher = options.fetcher ?? fetch;
  return {
    id: "supadata",
    async fetchTranscript(videoId, { language, signal }) {
      if (!VIDEO_ID.test(videoId)) return { ok: false, reason: "not_found" };
      const params = new URLSearchParams({ url: youtubeMomentUrl(videoId), mode: "native" });
      const lang = cleanLanguageTag(language);
      if (lang) params.set("lang", lang.split("-")[0]!.toLowerCase());
      let response: Response;
      try {
        response = await fetcher(`${SUPADATA_ENDPOINT}?${params.toString()}`, {
          headers: { "x-api-key": options.apiKey, accept: "application/json" },
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: false, reason: "timeout" };
        return { ok: false, reason: "unreachable" };
      }
      const status = response.status;
      if (status !== 200) response.body?.cancel().catch(() => {});
      if (status === 206) return { ok: false, reason: "no_captions" };
      if (status === 400 || status === 404) return { ok: false, reason: "not_found" };
      if (status === 401 || status === 403) {
        // An operator problem (a wrong or revoked key), said once in the server log — never with the key.
        console.warn(`[transcripts] supadata refused the request (HTTP ${status}); check SUPADATA_API_KEY`);
        return { ok: false, reason: "not_configured" };
      }
      if (status === 402 || status === 429) return { ok: false, reason: "rate_limited" };
      if (status === 202) return { ok: false, reason: "malformed" }; // a generation job; native mode should never start one
      if (status !== 200) return { ok: false, reason: "unreachable" };

      let bytes: Uint8Array;
      let truncated: boolean;
      try {
        ({ bytes, truncated } = await readCapped(response, TRANSCRIPT_LIMITS.responseBytes));
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: false, reason: "timeout" };
        return { ok: false, reason: "unreachable" };
      }
      if (truncated) return { ok: false, reason: "malformed" };
      try {
        return readSupadata(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}

/** The provider this server is configured with, or none. */
export function configuredTranscriptProvider(env: Record<string, string | undefined> = process.env): TranscriptProvider | null {
  const key = env.SUPADATA_API_KEY?.trim();
  return key ? supadataProvider({ apiKey: key }) : null;
}

// ─── Cache and de-duplication ────────────────────────────────────────────────

type FailureReason = Extract<TranscriptFetch, { ok: false }>["reason"];

/** Only answers a retry could not change are kept; a timeout or a rate limit is asked again. */
const TTL_MS: { found: number } & Partial<Record<FailureReason, number>> = {
  found: 24 * 60 * 60 * 1000,
  no_captions: 6 * 60 * 60 * 1000,
  not_found: 60 * 60 * 1000,
};
const MAX_CACHED = 200;

const cache = new Map<string, { value: TranscriptFetch; expiresAt: number }>();
const inFlight = new Map<string, Promise<TranscriptFetch>>();

function ttlOf(value: TranscriptFetch): number | undefined {
  return value.ok ? TTL_MS.found : TTL_MS[value.reason];
}

function remember(key: string, value: TranscriptFetch, now: number): void {
  const ttl = ttlOf(value);
  if (!ttl) return;
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttl });
  // Oldest first: a Map iterates in insertion order.
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/**
 * One video's captions through `provider`, cached and de-duplicated. Never
 * throws: every failure is a `reason` the caller turns into words.
 */
export async function getTranscript(
  videoId: string,
  options: { provider: TranscriptProvider | null; language?: string; timeoutMs?: number; now?: () => number }
): Promise<TranscriptFetch> {
  const { provider } = options;
  if (!provider) return { ok: false, reason: "not_configured" };
  if (!VIDEO_ID.test(videoId)) return { ok: false, reason: "not_found" };
  const now = options.now ?? Date.now;
  const language = cleanLanguageTag(options.language)?.split("-")[0]?.toLowerCase();
  const key = `${provider.id}:${videoId}:${language ?? ""}`;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;
  if (cached) cache.delete(key);

  const running = inFlight.get(key);
  if (running) return running;

  const call = (async () => {
    try {
      const value = await provider.fetchTranscript(videoId, { ...(language ? { language } : {}), signal: AbortSignal.timeout(options.timeoutMs ?? TRANSCRIPT_LIMITS.timeoutMs) });
      remember(key, value, now());
      return value;
    } catch {
      return { ok: false, reason: "unreachable" } as const;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, call);
  return call;
}

/** For tests. */
export function resetTranscriptCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

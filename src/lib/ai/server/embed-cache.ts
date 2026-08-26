import "server-only";
import { embedTexts as geminiEmbedTexts } from "@/lib/ai/gemini/client";
import { readCache, writeCache, hashText, DEFAULT_SUCCESS_TTL_MS, DEFAULT_FAILURE_TTL_MS } from "./cache";
import type { GeminiResult } from "@/lib/ai/gemini/types";

const inFlight = new Map<string, Promise<GeminiResult<number[]>>>();

function cacheKey(model: string, text: string): string {
  return `embed:${model}:${hashText(text)}`;
}

/**
 * Embeds `texts` against `model` with per-text caching and in-flight
 * coalescing. A text that's already been embedded before — by any caller,
 * any browser, any workspace — is never re-sent to Gemini; two concurrent
 * requests embedding the same text (e.g. two open windows indexing the same
 * unchanged workspace) share one Gemini call instead of firing two. Every
 * text that's genuinely new still goes out in a single batched
 * embedTexts() call, so partial cache hits never turn one batch request
 * into many individual ones.
 *
 * Returns the same all-or-nothing GeminiResult shape as the uncached
 * embedTexts() — callers (the /api/ai/embed route) don't need a second
 * failure shape to handle.
 */
export async function embedTextsCached(texts: string[], model: string): Promise<GeminiResult<number[][]>> {
  if (texts.length === 0) return { ok: true, data: [] };

  const keys = texts.map((t) => cacheKey(model, t));
  const results: (number[] | undefined)[] = new Array(texts.length);
  const waits: Promise<void>[] = [];
  const coldIndexes: number[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = readCache<number[]>(keys[i]);
    if (cached) {
      // A cached success resolves immediately; a cached (recent) failure is
      // deliberately NOT retried here — that's the whole point of caching
      // failures briefly (see DEFAULT_FAILURE_TTL_MS) — it just stays
      // unresolved and surfaces via the missing-result check below.
      if (cached.ok) results[i] = cached.data;
      continue;
    }

    const pending = inFlight.get(keys[i]);
    if (pending) {
      const idx = i;
      waits.push(pending.then((outcome) => { if (outcome.ok) results[idx] = outcome.data; }));
      continue;
    }

    coldIndexes.push(i);
  }

  if (coldIndexes.length > 0) {
    const uniqueKeys = Array.from(new Set(coldIndexes.map((i) => keys[i])));
    const textByKey = new Map(coldIndexes.map((i) => [keys[i], texts[i]]));
    const uniqueTexts = uniqueKeys.map((k) => textByKey.get(k)!);

    // embedTexts() never rejects in practice — every internal failure (fetch
    // throwing, a non-OK response, malformed JSON) is already caught and
    // returned as a GeminiResult failure (see gemini/client.ts). This catch
    // is defense-in-depth only, so a genuinely unexpected rejection here
    // still resolves every waiting key (never leaves the in-flight map
    // permanently stuck on an unhandled promise rejection) and is still
    // treated as a normal, briefly-cached failure rather than crashing the
    // route that called this.
    const batchPromise: Promise<Map<string, GeminiResult<number[]>>> = geminiEmbedTexts(uniqueTexts, model)
      .catch(
        (err): GeminiResult<number[][]> => ({
          ok: false,
          reason: "network-error",
          detail: err instanceof Error ? err.message : "unexpected embedding failure",
        })
      )
      .then((batchResult) => {
        const outByKey = new Map<string, GeminiResult<number[]>>();
        uniqueKeys.forEach((key, idx) => {
          const outcome: GeminiResult<number[]> = batchResult.ok
            ? { ok: true, data: batchResult.data[idx] }
            : { ok: false, reason: batchResult.reason, detail: batchResult.detail, status: batchResult.status };
          writeCache(key, outcome, outcome.ok ? DEFAULT_SUCCESS_TTL_MS : DEFAULT_FAILURE_TTL_MS);
          outByKey.set(key, outcome);
        });
        return outByKey;
      });

    for (const key of uniqueKeys) {
      const perKeyPromise = batchPromise.then((map) => map.get(key)!);
      inFlight.set(key, perKeyPromise);
      perKeyPromise.finally(() => {
        if (inFlight.get(key) === perKeyPromise) inFlight.delete(key);
      });
    }

    for (const i of coldIndexes) {
      const idx = i;
      waits.push(inFlight.get(keys[i])!.then((outcome) => { if (outcome.ok) results[idx] = outcome.data; }));
    }
  }

  await Promise.all(waits);

  const missingIndex = results.findIndex((r) => r === undefined);
  if (missingIndex !== -1) {
    const failed = readCache<number[]>(keys[missingIndex]);
    if (failed && !failed.ok) return failed;
    return { ok: false, reason: "malformed-response", detail: "embedding result missing for one or more texts" };
  }

  return { ok: true, data: results as number[][] };
}

export function __clearEmbedCacheForTests(): void {
  inFlight.clear();
}

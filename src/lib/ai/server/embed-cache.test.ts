import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChunks } from "@/lib/ai/chunk";
import type { Tab } from "@/lib/tabs/types";

const embedTextsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/gemini/client", () => ({
  embedTexts: embedTextsMock,
}));

const { embedTextsCached, __clearEmbedCacheForTests } = await import("./embed-cache");
const { __clearServerCacheForTests } = await import("./cache");

afterEach(() => {
  embedTextsMock.mockReset();
  __clearServerCacheForTests();
  __clearEmbedCacheForTests();
});

describe("embedTextsCached", () => {
  it("returns an empty result without calling Gemini for an empty input", async () => {
    const result = await embedTextsCached([], "model-a");
    expect(result).toEqual({ ok: true, data: [] });
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("calls Gemini once for a batch of new texts, in one request", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1], [0.2]] });

    const result = await embedTextsCached(["a", "b"], "model-a");

    expect(result).toEqual({ ok: true, data: [[0.1], [0.2]] });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(embedTextsMock).toHaveBeenCalledWith(["a", "b"], "model-a");
  });

  it("cache hit: a text embedded before is never re-sent to Gemini", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1]] });
    await embedTextsCached(["same text"], "model-a");
    embedTextsMock.mockClear();

    const result = await embedTextsCached(["same text"], "model-a");

    expect(result).toEqual({ ok: true, data: [[0.1]] });
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("duplicate text within one call is embedded once and the result reused for both", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.5]] });

    const result = await embedTextsCached(["dup", "dup"], "model-a");

    expect(result).toEqual({ ok: true, data: [[0.5], [0.5]] });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(embedTextsMock).toHaveBeenCalledWith(["dup"], "model-a");
  });

  it("mixes cache hits and misses into one batched call for only the misses", async () => {
    embedTextsMock.mockResolvedValueOnce({ ok: true, data: [[1]] });
    await embedTextsCached(["cached"], "model-a");
    embedTextsMock.mockClear();
    embedTextsMock.mockResolvedValueOnce({ ok: true, data: [[2], [3]] });

    const result = await embedTextsCached(["cached", "new-1", "new-2"], "model-a");

    expect(result).toEqual({ ok: true, data: [[1], [2], [3]] });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(embedTextsMock).toHaveBeenCalledWith(["new-1", "new-2"], "model-a");
  });

  it("concurrent identical requests share one Gemini call", async () => {
    let resolveEmbed!: (v: { ok: true; data: number[][] }) => void;
    embedTextsMock.mockReturnValue(new Promise((resolve) => { resolveEmbed = resolve; }));

    const p1 = embedTextsCached(["concurrent"], "model-a");
    const p2 = embedTextsCached(["concurrent"], "model-a");
    const p3 = embedTextsCached(["concurrent"], "model-a");

    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    resolveEmbed({ ok: true, data: [[9]] });

    expect(await p1).toEqual({ ok: true, data: [[9]] });
    expect(await p2).toEqual({ ok: true, data: [[9]] });
    expect(await p3).toEqual({ ok: true, data: [[9]] });
  });

  it("different models keep separate cache entries for the same text", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[1]] });
    await embedTextsCached(["text"], "model-a");
    embedTextsMock.mockClear();
    embedTextsMock.mockResolvedValue({ ok: true, data: [[2]] });

    const result = await embedTextsCached(["text"], "model-b");

    expect(result).toEqual({ ok: true, data: [[2]] });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
  });

  it("a URL that only differs by tracking params still cache-hits, because caching is content-addressed (the chunk text embedded never includes the URL/query string at all)", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.9]] });

    function makeTab(url: string): Tab {
      return { id: url, url, normalizedUrl: url, domain: "example.com", category: "research", title: "Same Article" };
    }
    const plainChunks = buildChunks(makeTab("https://example.com/article"));
    const trackedChunks = buildChunks(makeTab("https://example.com/article?utm_source=newsletter&utm_campaign=x"));

    // Same title/domain/category → identical chunk text regardless of the
    // URL's tracking params, so both tabs hash to the same cache key.
    expect(trackedChunks[0].text).toBe(plainChunks[0].text);

    await embedTextsCached([plainChunks[0].text], "model-a");
    embedTextsMock.mockClear();
    const result = await embedTextsCached([trackedChunks[0].text], "model-a");

    expect(result).toEqual({ ok: true, data: [[0.9]] });
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("propagates a Gemini failure (e.g. rate-limited) without caching a partial success", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "rate-limited", status: 429 });

    const result = await embedTextsCached(["x"], "model-a");

    expect(result).toEqual({ ok: false, reason: "rate-limited", status: 429 });
  });

  it("recovers gracefully (never hangs) if the underlying embed call rejects instead of resolving to a failure", async () => {
    embedTextsMock.mockRejectedValue(new Error("unexpected throw"));

    const result = await embedTextsCached(["x"], "model-a");
    expect(result.ok).toBe(false);

    // The in-flight entry must have been cleared — a later call retries
    // (and can succeed) rather than hanging forever on a dead promise.
    embedTextsMock.mockReset();
    embedTextsMock.mockResolvedValue({ ok: true, data: [[1]] });
    const retry = await embedTextsCached(["y"], "model-a");
    expect(retry).toEqual({ ok: true, data: [[1]] });
  });

  it("caches a recent failure so a retry doesn't hit Gemini again", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "gemini-error" });
    await embedTextsCached(["failing"], "model-a");
    embedTextsMock.mockClear();

    const result = await embedTextsCached(["failing"], "model-a");

    expect(result.ok).toBe(false);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });
});

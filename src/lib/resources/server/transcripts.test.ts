import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredTranscriptProvider, getTranscript, resetTranscriptCacheForTests, supadataProvider, TRANSCRIPT_LIMITS } from "./transcripts";
import { extractSource } from "./extract";
import { EXTRACTION_ERRORS } from "@/lib/resources/extraction";
import type { TranscriptFetch, TranscriptProvider } from "./transcripts";
import type { FetchedBytes } from "./fetch";

const ID = "dQw4w9WgXcQ";
const KEY = "test-key-not-real";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LECTURE = {
  lang: "en",
  availableLangs: ["en", "fr"],
  content: [
    { text: "Today we look at gravitational potential energy.", offset: 522_000, duration: 4_200, lang: "en" },
    { text: "Welcome to Physics revision.", offset: 0, duration: 3_000, lang: "en" },
    { text: "It&amp;#39;s the energy an object has   because of its height.", offset: 526_200, duration: 3_800 },
    { text: "   ", offset: 530_000, duration: 1_000 },
  ],
};

function provider(fetcher: typeof fetch) {
  return supadataProvider({ apiKey: KEY, fetcher });
}

beforeEach(() => resetTranscriptCacheForTests());

describe("supadataProvider", () => {
  it("asks for the video's own captions only, with the key in a header and never in the address", async () => {
    const fetcher = vi.fn(async () => jsonResponse(LECTURE));
    await provider(fetcher as unknown as typeof fetch).fetchTranscript(ID, { language: "en-GB", signal: AbortSignal.timeout(1000) });
    const [address, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(address);
    expect(url.origin + url.pathname).toBe("https://api.supadata.ai/v1/transcript");
    expect(url.searchParams.get("url")).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(url.searchParams.get("mode")).toBe("native");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(address).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(init.redirect).toBe("error");
  });

  it("returns ordered, cleaned segments with start and end in seconds", async () => {
    const result = await provider((async () => jsonResponse(LECTURE)) as unknown as typeof fetch).fetchTranscript(ID, { signal: AbortSignal.timeout(1000) });
    expect(result).toEqual({
      ok: true,
      provider: "supadata",
      language: "en",
      segments: [
        { start: 0, end: 3, text: "Welcome to Physics revision." },
        { start: 522, end: 526.2, text: "Today we look at gravitational potential energy." },
        { start: 526.2, end: 530, text: "It's the energy an object has because of its height." },
      ],
    });
  });

  it.each<[string, () => Response, TranscriptFetch]>([
    ["an empty transcript", () => jsonResponse({ lang: "en", availableLangs: [], content: [] }), { ok: false, reason: "no_captions" }],
    ["missing captions (206)", () => jsonResponse({ error: "transcript-unavailable", message: "x", details: "y" }, 206), { ok: false, reason: "no_captions" }],
    ["a missing video (404)", () => jsonResponse({ error: "not-found", message: "x", details: "y" }, 404), { ok: false, reason: "not_found" }],
    ["a rejected key (401)", () => jsonResponse({ error: "unauthorized", message: "x", details: "y" }, 401), { ok: false, reason: "not_configured" }],
    ["the rate limit (429)", () => jsonResponse({ error: "limit-exceeded", message: "x", details: "y" }, 429), { ok: false, reason: "rate_limited" }],
    ["an exhausted plan (402)", () => jsonResponse({ error: "upgrade-required", message: "x", details: "y" }, 402), { ok: false, reason: "rate_limited" }],
    ["a server error (500)", () => jsonResponse({ error: "internal-error", message: "x", details: "y" }, 500), { ok: false, reason: "unreachable" }],
    ["a generation job (202)", () => jsonResponse({ jobId: "abc" }, 202), { ok: false, reason: "malformed" }],
    ["text that is not JSON", () => jsonResponse("<html>oops</html>"), { ok: false, reason: "malformed" }],
    ["JSON that is not a transcript", () => jsonResponse({ content: "plain text instead" }), { ok: false, reason: "malformed" }],
    ["chunks with no text at all", () => jsonResponse({ content: [{ offset: 1 }, { offset: 2 }] }), { ok: false, reason: "malformed" }],
    ["an array at the top", () => jsonResponse([1, 2, 3]), { ok: false, reason: "malformed" }],
  ])("reports %s honestly", async (_label, respond, expected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await provider((async () => respond()) as unknown as typeof fetch).fetchTranscript(ID, { signal: AbortSignal.timeout(1000) });
    expect(result).toEqual(expected);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(KEY);
    warn.mockRestore();
  });

  it("reports a timeout and a network failure without throwing", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(provider((async () => Promise.reject(timeout)) as unknown as typeof fetch).fetchTranscript(ID, { signal: AbortSignal.timeout(1000) })).resolves.toEqual({ ok: false, reason: "timeout" });
    await expect(provider((async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch).fetchTranscript(ID, { signal: AbortSignal.timeout(1000) })).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses an answer larger than the bound instead of buffering it", async () => {
    const huge = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(TRANSCRIPT_LIMITS.responseBytes + 10));
      controller.close();
    } }), { status: 200 });
    await expect(provider((async () => huge) as unknown as typeof fetch).fetchTranscript(ID, { signal: AbortSignal.timeout(1000) })).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("never sends a request for something that is not a video id", async () => {
    const fetcher = vi.fn();
    await expect(provider(fetcher as unknown as typeof fetch).fetchTranscript("../../admin", { signal: AbortSignal.timeout(1000) })).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("configuredTranscriptProvider", () => {
  it("is off without a key", () => {
    expect(configuredTranscriptProvider({})).toBeNull();
    expect(configuredTranscriptProvider({ SUPADATA_API_KEY: "  " })).toBeNull();
    expect(configuredTranscriptProvider({ SUPADATA_API_KEY: KEY })?.id).toBe("supadata");
  });
});

describe("getTranscript", () => {
  function fakeProvider(answer: () => Promise<TranscriptFetch>) {
    const fetchTranscript = vi.fn(answer);
    return { provider: { id: "fake", fetchTranscript } satisfies TranscriptProvider, fetchTranscript };
  }
  const found: TranscriptFetch = { ok: true, provider: "fake", segments: [{ start: 1, text: "hello" }] };

  it("says not_configured without a provider", async () => {
    await expect(getTranscript(ID, { provider: null })).resolves.toEqual({ ok: false, reason: "not_configured" });
  });

  it("asks once for concurrent requests of one video", async () => {
    let release!: (value: TranscriptFetch) => void;
    const { provider: p, fetchTranscript } = fakeProvider(() => new Promise((resolve) => (release = resolve)));
    const both = Promise.all([getTranscript(ID, { provider: p }), getTranscript(ID, { provider: p })]);
    release(found);
    await expect(both).resolves.toEqual([found, found]);
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("caches a found transcript and 'no captions', but asks again after a transient failure", async () => {
    const answers: TranscriptFetch[] = [{ ok: false, reason: "rate_limited" }, found];
    const { provider: p, fetchTranscript } = fakeProvider(async () => answers.shift()!);
    expect(await getTranscript(ID, { provider: p })).toEqual({ ok: false, reason: "rate_limited" });
    expect(await getTranscript(ID, { provider: p })).toEqual(found);
    expect(await getTranscript(ID, { provider: p })).toEqual(found);
    expect(fetchTranscript).toHaveBeenCalledTimes(2);

    const none = fakeProvider(async () => ({ ok: false, reason: "no_captions" }));
    await getTranscript("aaaaaaaaaaa", { provider: none.provider });
    await getTranscript("aaaaaaaaaaa", { provider: none.provider });
    expect(none.fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("asks again once a cached answer expires", async () => {
    let clock = 1_000;
    const { provider: p, fetchTranscript } = fakeProvider(async () => found);
    await getTranscript(ID, { provider: p, now: () => clock });
    clock += 25 * 60 * 60 * 1000;
    await getTranscript(ID, { provider: p, now: () => clock });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
  });

  it("turns a provider that throws into a failure", async () => {
    const { provider: p } = fakeProvider(async () => {
      throw new Error("boom");
    });
    await expect(getTranscript(ID, { provider: p })).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("extractSource for a YouTube video", () => {
  const OEMBED = JSON.stringify({ title: "Gravitational potential energy — Physics revision", author_name: "Physics Online" });
  const oembed = (status = 200, body = OEMBED): FetchedBytes => ({ ok: true, finalUrl: "https://www.youtube.com/oembed", status, contentType: "application/json", bytes: new TextEncoder().encode(body), truncated: false });
  const transcriptOf = (answer: TranscriptFetch): TranscriptProvider => ({ id: "fake", fetchTranscript: async () => answer });
  const segments = [{ start: 522, end: 526, text: "Gravitational potential energy is mgh." }];

  afterEach(() => vi.restoreAllMocks());

  it("is ready with the transcript, its language and the video's metadata", async () => {
    const result = await extractSource(`https://youtu.be/${ID}?t=30`, {
      fetcher: async () => oembed(),
      transcripts: { provider: transcriptOf({ ok: true, provider: "fake", language: "en", segments }) },
    });
    expect(result).toEqual({
      ok: true,
      kind: "youtube",
      status: "ready",
      finalUrl: `https://www.youtube.com/watch?v=${ID}`,
      title: "Gravitational potential energy — Physics revision",
      meta: { siteName: "YouTube", author: "Physics Online" },
      content: { transcript: segments, transcriptInfo: { source: "captions", provider: "fake", language: "en" } },
    });
  });

  it("is ready from the transcript even when oEmbed is down", async () => {
    const result = await extractSource(`https://www.youtube.com/watch?v=${ID}`, {
      fetcher: async () => ({ ok: false, reason: "timeout" }),
      transcripts: { provider: transcriptOf({ ok: true, provider: "fake", segments }) },
    });
    expect(result).toMatchObject({ ok: true, status: "ready" });
  });

  it.each<[TranscriptFetch, { code: string; retryable: boolean }]>([
    [{ ok: false, reason: "not_configured" }, EXTRACTION_ERRORS.transcripts_off],
    [{ ok: false, reason: "no_captions" }, EXTRACTION_ERRORS.transcript_unavailable],
    [{ ok: false, reason: "not_found" }, EXTRACTION_ERRORS.video_unavailable],
    [{ ok: false, reason: "rate_limited" }, EXTRACTION_ERRORS.transcript_busy],
    [{ ok: false, reason: "timeout" }, EXTRACTION_ERRORS.transcript_timeout],
    [{ ok: false, reason: "malformed" }, EXTRACTION_ERRORS.transcript_failed],
  ])("saves the video with its metadata and says why when the transcript is %j", async (answer, error) => {
    const result = await extractSource(`https://www.youtube.com/shorts/${ID}`, { fetcher: async () => oembed(), transcripts: { provider: transcriptOf(answer) } });
    expect(result).toMatchObject({ ok: true, kind: "youtube", status: "partial", title: "Gravitational potential energy — Physics revision", error });
  });

  it.each([400, 404])("says a video oEmbed can't find (%i) is unavailable — with or without a provider", async (status) => {
    for (const provider of [transcriptOf({ ok: false, reason: "no_captions" }), null]) {
      const result = await extractSource(`https://www.youtube.com/watch?v=${ID}`, { fetcher: async () => oembed(status, "Bad Request"), transcripts: { provider } });
      expect(result).toMatchObject({ ok: true, status: "partial", error: EXTRACTION_ERRORS.video_unavailable });
    }
  });

  it("does not ask for a transcript once the caller's allowance is used", async () => {
    const fetchTranscript = vi.fn();
    const result = await extractSource(`https://www.youtube.com/watch?v=${ID}`, { fetcher: async () => oembed(), transcripts: { provider: { id: "fake", fetchTranscript }, allowed: false } });
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, status: "partial", error: EXTRACTION_ERRORS.transcript_busy });
  });

  it("fails retryably when neither metadata nor transcript could be reached", async () => {
    const result = await extractSource(`https://www.youtube.com/watch?v=${ID}`, { fetcher: async () => ({ ok: false, reason: "network" }), transcripts: { provider: null } });
    expect(result).toEqual({ ok: false, error: EXTRACTION_ERRORS.unreachable });
  });

  it("keeps a malformed oEmbed answer from breaking the read", async () => {
    const result = await extractSource(`https://www.youtube.com/watch?v=${ID}`, { fetcher: async () => oembed(200, "{not json"), transcripts: { provider: transcriptOf({ ok: true, provider: "fake", segments }) } });
    expect(result).toMatchObject({ ok: true, status: "ready", meta: { siteName: "YouTube" } });
    expect(result.ok && result.title).toBeFalsy();
  });
});

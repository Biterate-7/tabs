import { afterEach, describe, expect, it, vi } from "vitest";

const embedTextsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/gemini/client", () => ({
  embedTexts: embedTextsMock,
}));

const { POST } = await import("./route");
const { __clearServerCacheForTests } = await import("@/lib/ai/server/cache");
const { __clearEmbedCacheForTests } = await import("@/lib/ai/server/embed-cache");
const { __clearRateLimitsForTests } = await import("@/lib/ai/server/rate-limit");

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/ai/embed", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  embedTextsMock.mockReset();
  // The embed cache and rate limiter are process-wide singletons (see
  // src/lib/ai/server) — without resetting them, an earlier test's cached
  // "hello" embedding would silently short-circuit a later test's mock
  // expectations instead of actually exercising them.
  __clearServerCacheForTests();
  __clearEmbedCacheForTests();
  __clearRateLimitsForTests();
});

describe("POST /api/ai/embed", () => {
  it("returns 400 for malformed JSON", async () => {
    expect((await POST(postRequest("{not json"))).status).toBe(400);
  });

  it("returns 400 for an empty or missing texts array", async () => {
    expect((await POST(postRequest({}))).status).toBe(400);
    expect((await POST(postRequest({ texts: [] }))).status).toBe(400);
  });

  it("returns 400 when texts exceeds the max batch size", async () => {
    const response = await POST(postRequest({ texts: Array.from({ length: 101 }, () => "x") }));
    expect(response.status).toBe(400);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("returns embeddings on success", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1, 0.2]] });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embeddings: [[0.1, 0.2]] });
  });

  it("maps a missing-key failure to a 503 with a clean message", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "missing-key" });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("AI features aren't configured yet.");
  });

  it("maps a rate-limited failure to a 429", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "rate-limited" });
    expect((await POST(postRequest({ texts: ["hello"] }))).status).toBe(429);
  });

  it("maps a timeout failure to a 504 with a clean message (graceful degradation, not a crash)", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "timeout" });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe("Gemini took too long to respond — try again.");
  });

  it("maps a malformed-response failure to a 502 with a clean message", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "malformed-response", detail: "no embeddings array" });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("The AI service returned something we couldn't parse.");
    expect(body.detail).toBe("no embeddings array");
  });

  it("maps a raw network failure (fetch threw, e.g. DNS/connection refused) to a graceful 502, not a crash", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "network-error", detail: "fetch failed" });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("Couldn't reach the AI service.");
  });

  it("maps a 5xx / unavailable-model response from Gemini (surfaced as gemini-error) to a graceful 502 that still carries Gemini's own detail", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "gemini-error", detail: "model gemini-x is not found", status: 404 });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("The AI service returned an error.");
    expect(body.detail).toBe("model gemini-x is not found");
  });

  describe("caching and deduplication", () => {
    it("cache hit: re-embedding the same text in a later request never calls Gemini again", async () => {
      embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1, 0.2]] });
      await POST(postRequest({ texts: ["reused text"] }));
      expect(embedTextsMock).toHaveBeenCalledTimes(1);

      embedTextsMock.mockClear();
      const response = await POST(postRequest({ texts: ["reused text"] }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ embeddings: [[0.1, 0.2]] });
      expect(embedTextsMock).not.toHaveBeenCalled();
    });

    it("duplicate URLs/text in one request become a single Gemini call, result reused for both", async () => {
      embedTextsMock.mockResolvedValue({ ok: true, data: [[0.4]] });

      const response = await POST(postRequest({ texts: ["same", "same"] }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ embeddings: [[0.4], [0.4]] });
      expect(embedTextsMock).toHaveBeenCalledTimes(1);
    });

    it("concurrent identical requests are coalesced into one Gemini call", async () => {
      let resolveEmbed!: (v: { ok: true; data: number[][] }) => void;
      embedTextsMock.mockReturnValue(new Promise((resolve) => { resolveEmbed = resolve; }));

      const p1 = POST(postRequest({ texts: ["concurrent"] }));
      const p2 = POST(postRequest({ texts: ["concurrent"] }));
      // Each POST call awaits request.json() before it ever reaches
      // embedTextsCached — give both a chance to get there before asserting.
      await vi.waitFor(() => expect(embedTextsMock).toHaveBeenCalledTimes(1));

      resolveEmbed({ ok: true, data: [[7]] });
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(await r1.json()).toEqual({ embeddings: [[7]] });
      expect(await r2.json()).toEqual({ embeddings: [[7]] });
    });
  });

  describe("per-IP rate limiting", () => {
    function postFrom(ip: string, body: unknown): Request {
      return new Request("https://tabdump.example/api/ai/embed", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
      });
    }

    it("blocks further requests from the same IP once the limit is hit, without ever calling Gemini for the blocked one", async () => {
      embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1]] });

      for (let i = 0; i < 40; i++) {
        const response = await POST(postFrom("203.0.113.5", { texts: [`text-${i}`] }));
        expect(response.status).toBe(200);
      }

      embedTextsMock.mockClear();
      const blocked = await POST(postFrom("203.0.113.5", { texts: ["one-too-many"] }));

      expect(blocked.status).toBe(429);
      expect(embedTextsMock).not.toHaveBeenCalled();
      const body = await blocked.json();
      expect(body.error).toBe("Too many requests right now — try again shortly.");
    });

    it("does not rate-limit a different IP once one IP is exhausted", async () => {
      embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1]] });

      for (let i = 0; i < 40; i++) {
        await POST(postFrom("203.0.113.9", { texts: [`t-${i}`] }));
      }
      const otherIp = await POST(postFrom("203.0.113.10", { texts: ["fresh"] }));

      expect(otherIp.status).toBe(200);
    });
  });
});

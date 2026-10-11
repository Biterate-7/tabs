import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractSource = vi.fn(async (url: string) => ({ ok: true, kind: "youtube", status: "partial", finalUrl: url, meta: {} }));
vi.mock("@/lib/resources/server/extract", () => ({ extractSource }));

const { POST } = await import("./route");
const { __clearRateLimitsForTests } = await import("@/lib/ai/server/rate-limit");

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function post(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://hubble.test/api/resources/extract", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Options = { transcripts?: { provider: { id: string } | null; language?: string; allowed?: boolean } };
const lastOptions = () => (extractSource.mock.calls.at(-1) as unknown[])[1] as Options;

beforeEach(() => {
  __clearRateLimitsForTests();
  extractSource.mockClear();
  vi.stubEnv("SUPADATA_API_KEY", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/resources/extract", () => {
  it("refuses a non-web address and an oversized body before doing anything", async () => {
    expect((await POST(post({ url: "file:///etc/passwd" }))).status).toBe(400);
    expect((await POST(post({ url: `${VIDEO}&x=${"a".repeat(20_000)}` }))).status).toBe(413);
    expect((await POST(post("{nope"))).status).toBe(400);
    expect(extractSource).not.toHaveBeenCalled();
  });

  it("has no transcript provider without a key — and says so to the reader, not by failing", async () => {
    const response = await POST(post({ url: VIDEO, kind: "youtube" }));
    expect(response.status).toBe(200);
    expect(lastOptions().transcripts).toEqual({ provider: null, allowed: true });
  });

  it("passes a valid language hint on, and drops anything else", async () => {
    vi.stubEnv("SUPADATA_API_KEY", "test-key");
    await POST(post({ url: VIDEO, kind: "youtube", language: "en-GB" }));
    expect(lastOptions().transcripts).toMatchObject({ provider: { id: "supadata" }, language: "en-GB", allowed: true });
    await POST(post({ url: VIDEO, kind: "youtube", language: "en; DROP TABLE" }));
    expect(lastOptions().transcripts?.language).toBeUndefined();
  });

  it("gives transcripts their own allowance per caller; past it a video is still read, without asking for one", async () => {
    vi.stubEnv("SUPADATA_API_KEY", "test-key");
    for (let i = 0; i < 60; i++) await POST(post({ url: VIDEO, kind: "youtube" }));
    expect(lastOptions().transcripts?.allowed).toBe(true);
    const response = await POST(post({ url: VIDEO, kind: "youtube" }));
    expect(response.status).toBe(200);
    expect(lastOptions().transcripts?.allowed).toBe(false);
    // Another caller has its own allowance; web pages never spend it.
    await POST(post({ url: VIDEO, kind: "youtube" }, "198.51.100.1"));
    expect(lastOptions().transcripts?.allowed).toBe(true);
    await POST(post({ url: "https://example.com/article" }));
    expect(lastOptions().transcripts?.allowed).toBe(true);
  });

  it("never echoes the key in a response", async () => {
    vi.stubEnv("SUPADATA_API_KEY", "secret-key-123");
    const response = await POST(post({ url: VIDEO, kind: "youtube" }));
    expect(await response.text()).not.toContain("secret-key-123");
  });
});

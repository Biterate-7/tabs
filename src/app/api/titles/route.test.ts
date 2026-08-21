import { afterEach, describe, expect, it, vi } from "vitest";

const resolveTitleMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/titles/server/registry", () => ({
  resolveTitle: resolveTitleMock,
}));

const { POST } = await import("./route");

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/titles", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  resolveTitleMock.mockReset();
});

describe("POST /api/titles", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await POST(postRequest("{not json"));
    expect(response.status).toBe(400);
  });

  it("returns 400 when urls is missing or not a string array", async () => {
    const responseA = await POST(postRequest({}));
    expect(responseA.status).toBe(400);

    const responseB = await POST(postRequest({ urls: [1, 2, 3] }));
    expect(responseB.status).toBe(400);
  });

  it("resolves each URL and returns one result per input, in order", async () => {
    resolveTitleMock.mockImplementation(async (url: string) =>
      url.includes("ok")
        ? { ok: true, title: `Title for ${url}`, source: "generic" }
        : { ok: false, reason: "no-title", permanent: true }
    );

    const response = await POST(
      postRequest({ urls: ["https://ok-one.example", "https://fails.example", "https://ok-two.example"] })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([
      { url: "https://ok-one.example", ok: true, title: "Title for https://ok-one.example", source: "generic" },
      { url: "https://fails.example", ok: false, reason: "no-title", permanent: true },
      { url: "https://ok-two.example", ok: true, title: "Title for https://ok-two.example", source: "generic" },
    ]);
  });

  it("rejects unsafe URLs before ever calling the resolver", async () => {
    const response = await POST(postRequest({ urls: ["http://127.0.0.1/admin"] }));
    const body = await response.json();
    expect(body.results).toEqual([
      { url: "http://127.0.0.1/admin", ok: false, reason: "invalid-url", permanent: true },
    ]);
    expect(resolveTitleMock).not.toHaveBeenCalled();
  });

  it("truncates batches larger than the max instead of rejecting them", async () => {
    resolveTitleMock.mockResolvedValue({ ok: true, title: "T", source: "generic" });
    const urls = Array.from({ length: 60 }, (_, i) => `https://example.com/${i}`);
    const response = await POST(postRequest({ urls }));
    const body = await response.json();
    expect(body.results).toHaveLength(50);
  });

  it("never exceeds the server-side concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    resolveTitleMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { ok: true, title: "T", source: "generic" };
    });

    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
    await POST(postRequest({ urls }));

    expect(maxActive).toBeLessThanOrEqual(6);
    expect(maxActive).toBeGreaterThan(1); // actually ran concurrently, not one-at-a-time
  });
});

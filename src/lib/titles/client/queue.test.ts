import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestTitles, __resetTitleQueueForTests } from "./queue";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function successResult(url: string) {
  return { url, ok: true as const, title: `Title: ${url}`, source: "generic" };
}

beforeEach(() => {
  __resetTitleQueueForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestTitles", () => {
  it("returns an empty array for an empty input without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestTitles([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a single POST request for a batch within the batch size", async () => {
    const urls = ["https://a.example", "https://b.example"];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: urls.map(successResult) }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await requestTitles(urls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/titles",
      expect.objectContaining({ method: "POST" })
    );
    expect(results).toEqual(urls.map(successResult));
  });

  it("splits more than 8 urls across multiple batch requests", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const { urls: batchUrls } = JSON.parse(init.body as string);
      return jsonResponse({ results: batchUrls.map(successResult) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await requestTitles(urls);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3); // 20 / 8 -> 3 batches
    expect(results).toEqual(urls.map(successResult));
  });

  it("preserves input order and duplicates in the returned results", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const { urls: batchUrls } = JSON.parse(init.body as string);
      return jsonResponse({ results: batchUrls.map(successResult) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await requestTitles(["https://a.example", "https://b.example", "https://a.example"]);

    expect(results).toEqual([
      successResult("https://a.example"),
      successResult("https://b.example"),
      successResult("https://a.example"),
    ]);
  });

  it("de-duplicates two overlapping calls for the same URL into one network request", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      callCount += 1;
      const { urls: batchUrls } = JSON.parse(init.body as string);
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ results: batchUrls.map(successResult) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [resultsA, resultsB] = await Promise.all([
      requestTitles(["https://shared.example"]),
      requestTitles(["https://shared.example"]),
    ]);

    expect(callCount).toBe(1);
    expect(resultsA).toEqual([successResult("https://shared.example")]);
    expect(resultsB).toEqual([successResult("https://shared.example")]);
  });

  it("falls back to network-error for every URL when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const results = await requestTitles(["https://a.example", "https://b.example"]);
    expect(results).toEqual([
      { url: "https://a.example", ok: false, reason: "network-error", permanent: false },
      { url: "https://b.example", ok: false, reason: "network-error", permanent: false },
    ]);
  });

  it("falls back to network-error for every URL when the response is a non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const results = await requestTitles(["https://a.example"]);
    expect(results).toEqual([
      { url: "https://a.example", ok: false, reason: "network-error", permanent: false },
    ]);
  });

  it("respects the client-side concurrency cap across many batches", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const { urls: batchUrls } = JSON.parse(init.body as string);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return jsonResponse({ results: batchUrls.map(successResult) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const urls = Array.from({ length: 80 }, (_, i) => `https://example.com/${i}`); // 10 batches of 8
    await requestTitles(urls);

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });
});

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { resolveGoogleFileTitles, __resetGoogleTitleCacheForTests } from "./resolve-titles";

beforeEach(() => {
  __resetGoogleTitleCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchJson(data: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(data), { status: ok ? 200 : 500 }))
  );
}

describe("resolveGoogleFileTitles", () => {
  it("posts the requested file ids and returns metadata keyed by id", async () => {
    stubFetchJson({
      authenticated: true,
      results: { a: { name: "Doc A", mimeType: "doc" }, b: null },
    });

    const result = await resolveGoogleFileTitles(["a", "b"]);

    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.get("a")).toEqual({ name: "Doc A", mimeType: "doc" });
    expect(result.metadataByFileId.get("b")).toBeNull();
  });

  it("caches resolved results and does not re-fetch the same file id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: true, results: { a: { name: "Doc A", mimeType: "doc" } } }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolveGoogleFileTitles(["a"]);
    const second = await resolveGoogleFileTitles(["a"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.metadataByFileId.get("a")).toEqual({ name: "Doc A", mimeType: "doc" });
  });

  it("only requests the uncached subset when some ids are already cached", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { fileIds: string[] };
      const results = Object.fromEntries(body.fileIds.map((id) => [id, { name: id, mimeType: "doc" }]));
      return new Response(JSON.stringify({ authenticated: true, results }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveGoogleFileTitles(["a"]);
    await resolveGoogleFileTitles(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondCallBody.fileIds).toEqual(["b"]);
  });

  it("signals authenticated:false without caching failures as permanent", async () => {
    stubFetchJson({ authenticated: false, results: {} });

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(false);
    expect(result.metadataByFileId.has("a")).toBe(false);
  });

  it("falls back gracefully (authenticated:true, empty map) on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.size).toBe(0);
  });

  it("falls back gracefully on a non-ok HTTP response", async () => {
    stubFetchJson({}, false);

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.size).toBe(0);
  });

  it("returns an empty result without a network call for an empty input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGoogleFileTitles([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ authenticated: true, metadataByFileId: new Map() });
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchDriveFileMetadata } from "./drive-metadata";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", impl);
}

describe("fetchDriveFileMetadata", () => {
  it("returns name and mimeType on a successful response", async () => {
    stubFetch(
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: "1abc", name: "Quarterly Product Strategy", mimeType: "application/vnd.google-apps.document" }),
          { status: 200 }
        )
      ) as unknown as typeof fetch
    );

    const result = await fetchDriveFileMetadata("1abc", "token-123");
    expect(result).toEqual({
      name: "Quarterly Product Strategy",
      mimeType: "application/vnd.google-apps.document",
    });
  });

  it("sends the access token as a bearer header and requests only id,name,mimeType", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "Doc" }), { status: 200 }));
    stubFetch(fetchMock as unknown as typeof fetch);

    await fetchDriveFileMetadata("file-1", "my-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/drive/v3/files/file-1");
    expect(url).toContain("fields=id%2Cname%2CmimeType");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-token");
  });

  it("returns null when the file doesn't exist (404)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("missing", "token")).toBeNull();
  });

  it("returns null when access is denied (403)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("forbidden", "token")).toBeNull();
  });

  it("returns null on a server/rate-limit error (500/429)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("rate-limited", "token")).toBeNull();
  });

  it("returns null when the response body is missing a name", async () => {
    stubFetch(vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("x", "token")).toBeNull();
  });

  it("returns null on a network failure without throwing", async () => {
    stubFetch(vi.fn(async () => { throw new TypeError("network error"); }) as unknown as typeof fetch);
    await expect(fetchDriveFileMetadata("x", "token")).resolves.toBeNull();
  });

  it("aborts and returns null when the request exceeds the timeout", async () => {
    stubFetch(
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }) as unknown as typeof fetch
    );

    vi.useFakeTimers();
    const promise = fetchDriveFileMetadata("slow", "token");
    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBytes, resolvesPublicly } from "./fetch";

afterEach(() => vi.unstubAllGlobals());

const OPTIONS = { accept: "*/*", maxBytes: 16, timeoutMs: 2000, check: async (url: string) => !new URL(url).hostname.startsWith("169.254") && !new URL(url).hostname.startsWith("10.") };

describe("fetchBytes", () => {
  it("checks every redirect hop, refusing one that lands on a private address", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "https://public.example/a" ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) : new Response("secret")
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchBytes("https://public.example/a", OPTIONS)).toEqual({ ok: false, reason: "unsafe" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows safe redirects and reports where it ended", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "https://a.example/start" ? new Response(null, { status: 301, headers: { location: "/final" } }) : new Response("hello", { headers: { "content-type": "text/plain" } })
      )
    );
    const result = await fetchBytes("https://a.example/start", OPTIONS);
    expect(result).toMatchObject({ ok: true, finalUrl: "https://a.example/final", status: 200, contentType: "text/plain", truncated: false });
  });

  it("stops reading at the byte cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(100))));
    const result = await fetchBytes("https://a.example/big", OPTIONS);
    expect(result.ok && result.bytes.byteLength).toBe(16);
    expect(result.ok && result.truncated).toBe(true);
  });

  it("gives up on a redirect loop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://a.example/again" } })));
    expect(await fetchBytes("https://a.example/again", OPTIONS)).toEqual({ ok: false, reason: "too-many-redirects" });
  });

  it("reports a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await fetchBytes("https://a.example/", OPTIONS)).toEqual({ ok: false, reason: "network" });
  });
});

describe("resolvesPublicly", () => {
  it("refuses private and loopback literals without a lookup", async () => {
    for (const url of ["http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://localhost/", "http://169.254.169.254/"]) {
      expect(await resolvesPublicly(url)).toBe(false);
    }
  });

  it("allows a public literal", async () => {
    expect(await resolvesPublicly("https://93.184.216.34/")).toBe(true);
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG, SVG } from "@/lib/favicon/__fixtures__/icons";

const resolveFaviconMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/favicon/server/resolve", () => ({
  resolveFavicon: resolveFaviconMock,
}));

const { GET } = await import("./route");

const get = (query: string) => GET(new Request(`https://hubble-hq.vercel.app/api/favicon${query}`));

afterEach(() => {
  resolveFaviconMock.mockReset();
});

describe("GET /api/favicon", () => {
  it("serves the resolved icon bytes with its sniffed type and a long cache", async () => {
    resolveFaviconMock.mockResolvedValue({ ok: true, body: PNG, contentType: "image/png", source: "https://site.com/i.png" });
    const response = await get("?host=console.cloud.google.com");

    expect(resolveFaviconMock).toHaveBeenCalledWith("console.cloud.google.com", expect.anything());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    // Readable cross-origin by the desktop app.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("makes a directly-opened SVG inert", async () => {
    resolveFaviconMock.mockResolvedValue({ ok: true, body: SVG, contentType: "image/svg+xml", source: "x" });
    const response = await get("?host=site.com");
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a miss with JSON giving the reason — never a placeholder image — cached only briefly", async () => {
    for (const reason of ["not-found", "unreachable"]) {
      resolveFaviconMock.mockResolvedValue({ ok: false, reason });
      const response = await get("?host=no-icon.com");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ icon: null, reason });
      // Short enough that a site which adds a favicon recovers within the hour.
      expect(response.headers.get("cache-control")).toBe("public, max-age=600, s-maxage=3600");
    }
  });

  it("normalises the host so one site has one cache key", async () => {
    resolveFaviconMock.mockResolvedValue({ ok: false, reason: "not-found" });
    await get("?host=GitHub.COM.");
    expect(resolveFaviconMock).toHaveBeenCalledWith("github.com", expect.anything());
  });

  it("rejects missing, private and URL-shaped hosts without resolving anything", async () => {
    for (const query of [
      "",
      "?host=",
      "?host=localhost",
      "?host=127.0.0.1",
      "?host=169.254.169.254",
      "?host=metadata.google.internal",
      "?host=https://evil.com/",
      "?host=evil.com/admin",
      "?host=evil.com:8080",
      "?url=https://site.com/",
    ]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ icon: null, reason: "invalid-host" });
    }
    expect(resolveFaviconMock).not.toHaveBeenCalled();
  });
});

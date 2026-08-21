import { afterEach, describe, expect, it, vi } from "vitest";
import { genericResolver, extractTitleFromHtml } from "./generic";
import { toResolverContext } from "@/lib/titles/types";

function htmlResponse(html: string, init: Partial<{ status: number; contentType: string }> = {}) {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractTitleFromHtml", () => {
  it("prefers og:title over twitter:title and <title>", async () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta name="twitter:title" content="Twitter Title">
        <meta property="og:title" content="OG Title">
      </head></html>`;
    expect(await extractTitleFromHtml(html)).toBe("OG Title");
  });

  it("falls back to twitter:title when og:title is missing", async () => {
    const html = `<meta name="twitter:title" content="Twitter Title"><title>Fallback</title>`;
    expect(await extractTitleFromHtml(html)).toBe("Twitter Title");
  });

  it("falls back to <title> when no meta tags are present", async () => {
    expect(await extractTitleFromHtml("<title>Just A Title</title>")).toBe("Just A Title");
  });

  it("decodes HTML entities and collapses whitespace", async () => {
    const html = `<title>Foo &amp; Bar &mdash;\n  Baz</title>`;
    expect(await extractTitleFromHtml(html)).toBe("Foo & Bar &mdash; Baz");
  });

  it("returns null when nothing is found", async () => {
    expect(await extractTitleFromHtml("<html><body>no title here</body></html>")).toBeNull();
  });
});

describe("genericResolver", () => {
  it("canHandle always returns true (catch-all)", () => {
    expect(genericResolver.canHandle(toResolverContext("https://anything.example/x"))).toBe(true);
  });

  it("resolves a successful HTML fetch to a title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(`<meta property="og:title" content="Hello World">`))
    );
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: true, title: "Hello World", source: "generic" });
  });

  it("classifies 401/403 as auth-required (not permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status: 403 })));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "auth-required", permanent: false });
  });

  it("classifies 404 as not-found (permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status: 404 })));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "not-found", permanent: true });
  });

  it("classifies other non-ok statuses as blocked (not permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status: 503 })));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "blocked", permanent: false });
  });

  it("classifies non-HTML content types as no-title (permanent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("{}", { contentType: "application/json" }))
    );
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com/api"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "no-title", permanent: true });
  });

  it("classifies HTML with no extractable title as no-title (permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("<html><body>hi</body></html>")));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "no-title", permanent: true });
  });

  it("classifies a network failure as network-error (not permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "network-error", permanent: false });
  });

  it("classifies a timeout as timeout (not permanent)", async () => {
    const timeoutError = new Error("timeout");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
    const result = await genericResolver.resolve(
      toResolverContext("https://example.com"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "timeout", permanent: false });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeOEmbedResolver } from "./youtube-oembed";
import { toResolverContext } from "@/lib/titles/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("youtubeOEmbedResolver.canHandle", () => {
  it("claims /watch?v= URLs", () => {
    expect(
      youtubeOEmbedResolver.canHandle(toResolverContext("https://www.youtube.com/watch?v=abc123"))
    ).toBe(true);
  });

  it("claims youtu.be short links", () => {
    expect(youtubeOEmbedResolver.canHandle(toResolverContext("https://youtu.be/abc123"))).toBe(true);
  });

  it("claims /shorts/ links", () => {
    expect(
      youtubeOEmbedResolver.canHandle(toResolverContext("https://www.youtube.com/shorts/abc123"))
    ).toBe(true);
  });

  it("does not claim non-video YouTube pages (channels, home)", () => {
    expect(
      youtubeOEmbedResolver.canHandle(toResolverContext("https://www.youtube.com/@somechannel"))
    ).toBe(false);
    expect(youtubeOEmbedResolver.canHandle(toResolverContext("https://www.youtube.com/"))).toBe(false);
  });

  it("does not claim unrelated hosts", () => {
    expect(youtubeOEmbedResolver.canHandle(toResolverContext("https://vimeo.com/12345"))).toBe(false);
  });
});

describe("youtubeOEmbedResolver.resolve", () => {
  it("resolves a title from the oEmbed JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ title: "My Cool Video" })));
    const result = await youtubeOEmbedResolver.resolve(
      toResolverContext("https://www.youtube.com/watch?v=abc123"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: true, title: "My Cool Video", source: "youtube-oembed" });
  });

  it("classifies a 404 (removed/private video) as not-found (permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const result = await youtubeOEmbedResolver.resolve(
      toResolverContext("https://www.youtube.com/watch?v=gone"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "not-found", permanent: true });
  });

  it("classifies a 5xx as blocked (not permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    const result = await youtubeOEmbedResolver.resolve(
      toResolverContext("https://www.youtube.com/watch?v=abc123"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "blocked", permanent: false });
  });

  it("classifies a network failure as network-error (not permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const result = await youtubeOEmbedResolver.resolve(
      toResolverContext("https://www.youtube.com/watch?v=abc123"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "network-error", permanent: false });
  });
});

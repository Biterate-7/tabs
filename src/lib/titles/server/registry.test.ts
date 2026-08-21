import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTitle } from "./registry";

function htmlResponse(html: string, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTitle", () => {
  it("dispatches Google Docs URLs to the Google Docs resolver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<title>Notes - Google Docs</title>"))
    );
    const result = await resolveTitle("https://docs.google.com/document/d/abc/edit");
    expect(result).toEqual({ ok: true, title: "Notes", source: "google-docs" });
  });

  it("dispatches YouTube watch URLs to the oEmbed resolver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ title: "A Video" }), {
          headers: { "content-type": "application/json" },
        })
      )
    );
    const result = await resolveTitle("https://www.youtube.com/watch?v=abc123");
    expect(result).toEqual({ ok: true, title: "A Video", source: "youtube-oembed" });
  });

  it("falls through to the generic resolver for a non-video YouTube page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(`<meta property="og:title" content="Some Channel">`))
    );
    const result = await resolveTitle("https://www.youtube.com/@somechannel");
    expect(result).toEqual({ ok: true, title: "Some Channel", source: "generic" });
  });

  it("dispatches ordinary URLs to the generic resolver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(`<meta property="og:title" content="Ordinary Page">`))
    );
    const result = await resolveTitle("https://example.com/post/1");
    expect(result).toEqual({ ok: true, title: "Ordinary Page", source: "generic" });
  });

  it("does not fall through from Google Docs to generic on an auth wall", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse("", 403));
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveTitle("https://docs.google.com/document/d/private/edit");
    expect(result).toEqual({ ok: false, reason: "auth-required", permanent: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never tried the generic resolver afterward
  });

  it("returns invalid-url (permanent) for a malformed URL without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveTitle("not a url");
    expect(result).toEqual({ ok: false, reason: "invalid-url", permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when a resolver rejects unexpectedly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(resolveTitle("https://example.com")).resolves.toEqual({
      ok: false,
      reason: "network-error",
      permanent: false,
    });
  });
});

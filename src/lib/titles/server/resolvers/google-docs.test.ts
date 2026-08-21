import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocsResolver } from "./google-docs";
import { toResolverContext } from "@/lib/titles/types";

function htmlResponse(html: string, init: Partial<{ status: number; url: string }> = {}) {
  const response = new Response(html, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  if (init.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleDocsResolver.canHandle", () => {
  it("claims docs.google.com and drive.google.com", () => {
    expect(googleDocsResolver.canHandle(toResolverContext("https://docs.google.com/document/d/1/edit"))).toBe(true);
    expect(googleDocsResolver.canHandle(toResolverContext("https://drive.google.com/file/d/1/view"))).toBe(true);
  });

  it("does not claim unrelated Google hosts", () => {
    expect(googleDocsResolver.canHandle(toResolverContext("https://www.google.com/search?q=x"))).toBe(false);
    expect(googleDocsResolver.canHandle(toResolverContext("https://mail.google.com/mail/u/0")))
      .toBe(false);
  });
});

describe("googleDocsResolver.resolve", () => {
  it("extracts a title and strips the trailing Google Docs suffix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<title>Q3 Roadmap - Google Docs</title>"))
    );
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/document/d/abc/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: true, title: "Q3 Roadmap", source: "google-docs" });
  });

  it("strips Sheets/Slides suffix variants too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<title>Budget – Google Sheets</title>"))
    );
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/spreadsheets/d/abc/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: true, title: "Budget", source: "google-docs" });
  });

  it("classifies a redirect to accounts.google.com as auth-required, not the login page's title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse("<title>Sign in - Google Accounts</title>", {
          url: "https://accounts.google.com/ServiceLogin?service=wise",
        })
      )
    );
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/document/d/private/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "auth-required", permanent: false });
  });

  it("classifies a direct 403/401 as auth-required", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status: 403 })));
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/document/d/private/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "auth-required", permanent: false });
  });

  it("classifies a 404 as not-found (permanent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status: 404 })));
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/document/d/gone/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "not-found", permanent: true });
  });

  it("propagates network/timeout failures from the shared fetch helper", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const result = await googleDocsResolver.resolve(
      toResolverContext("https://docs.google.com/document/d/x/edit"),
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, reason: "network-error", permanent: false });
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { HTML_ERROR_PAGE, ICO, PNG, SVG } from "../__fixtures__/icons";
import { resolveFavicon } from "./resolve";
import type { SafeFetchResult, SafeFetcher } from "./safe-fetch";

type Route = SafeFetchResult | { redirectTo: string };

/**
 * A fake network. Keys are requested URLs; a `redirectTo` entry resolves to
 * whatever that URL serves, with the final URL reported — the same contract
 * the real safe fetcher has after following redirects itself.
 */
function network(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetcher: SafeFetcher = vi.fn(async (url: string) => {
    requested.push(url);
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const route = routes[current];
      if (!route) return { ok: false, reason: "network" } as const;
      if ("redirectTo" in route) {
        current = route.redirectTo;
        continue;
      }
      return route.ok ? { ...route, url: current } : route;
    }
    return { ok: false, reason: "too-many-redirects" } as const;
  });
  return { fetcher, requested };
}

const html = (body: string): SafeFetchResult => ({
  ok: true,
  url: "",
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: Buffer.from(body),
});
const file = (body: Buffer, contentType = "application/octet-stream", status = 200): SafeFetchResult => ({
  ok: true,
  url: "",
  status,
  contentType,
  body,
});
const notFound = file(Buffer.from("Not Found"), "text/plain", 404);

describe("resolveFavicon", () => {
  it("falls back to /favicon.ico for a site that declares nothing", async () => {
    const { fetcher } = network({
      "https://plain.com/": html("<html><head><title>Plain</title></head></html>"),
      "https://plain.com/favicon.ico": file(ICO, "image/vnd.microsoft.icon"),
    });
    const result = await resolveFavicon("plain.com", { fetcher });
    expect(result).toMatchObject({ ok: true, contentType: "image/x-icon", source: "https://plain.com/favicon.ico" });
  });

  it("uses a <link rel=icon> declaration before /favicon.ico", async () => {
    const { fetcher, requested } = network({
      "https://declared.com/": html(`<head><link rel="icon" href="/static/brand.svg" type="image/svg+xml"></head>`),
      "https://declared.com/static/brand.svg": file(SVG, "image/svg+xml"),
      "https://declared.com/favicon.ico": file(ICO),
    });
    const result = await resolveFavicon("declared.com", { fetcher });
    expect(result).toMatchObject({ ok: true, contentType: "image/svg+xml", source: "https://declared.com/static/brand.svg" });
    expect(requested).not.toContain("https://declared.com/favicon.ico");
  });

  it("resolves a relative icon against the post-redirect page URL", async () => {
    const { fetcher } = network({
      "https://relative.com/": { redirectTo: "https://relative.com/en/home/" },
      "https://relative.com/en/home/": html(`<link rel="icon" href="img/icon.png">`),
      "https://relative.com/en/home/img/icon.png": file(PNG, "image/png"),
    });
    const result = await resolveFavicon("relative.com", { fetcher });
    expect(result).toMatchObject({ ok: true, source: "https://relative.com/en/home/img/icon.png" });
  });

  it("follows an absolute icon URL onto a CDN host", async () => {
    const { fetcher } = network({
      "https://cdn-icon.com/": html(`<link rel="icon" href="https://assets.cdn-icon-static.net/fav.png">`),
      "https://assets.cdn-icon-static.net/fav.png": file(PNG, "image/png"),
    });
    const result = await resolveFavicon("cdn-icon.com", { fetcher });
    expect(result).toMatchObject({ ok: true, source: "https://assets.cdn-icon-static.net/fav.png" });
  });

  it("resolves console.cloud.google.com to its own icon, not the sign-in page's or cloud.google.com's", async () => {
    // Recorded behaviour: the signed-out console redirects to an
    // accounts.google.com sign-in page, while its /favicon.ico redirects to
    // the console icon on ssl.gstatic.com.
    const { fetcher, requested } = network({
      "https://console.cloud.google.com/": { redirectTo: "https://accounts.google.com/v3/signin/identifier" },
      "https://accounts.google.com/v3/signin/identifier": html(
        `<head><link rel="icon" href="https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_32dp.png"></head>`
      ),
      "https://console.cloud.google.com/favicon.ico": { redirectTo: "https://ssl.gstatic.com/pantheon/images/favicon.ico" },
      "https://ssl.gstatic.com/pantheon/images/favicon.ico": file(ICO, "image/x-icon"),
      "https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_32dp.png": file(PNG, "image/png"),
    });
    const result = await resolveFavicon("console.cloud.google.com", { fetcher });
    expect(result).toMatchObject({ ok: true, source: "https://ssl.gstatic.com/pantheon/images/favicon.ico" });
    expect(requested.some((url) => url.startsWith("https://cloud.google.com"))).toBe(false);
    expect(requested).not.toContain("https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_32dp.png");
  });

  it("resolves Hubble's own deployment from its declared Next.js icon", async () => {
    const { fetcher } = network({
      "https://hubble-hq.vercel.app/": html(
        `<head><link rel="icon" href="/favicon.ico?favicon.38e20fl_719mw.ico" sizes="48x48" type="image/x-icon"/>` +
          `<link rel="icon" href="/icon.png?icon.3x-vget-3-0dj.png" sizes="512x512" type="image/png"/></head>`
      ),
      "https://hubble-hq.vercel.app/favicon.ico?favicon.38e20fl_719mw.ico": file(ICO, "image/vnd.microsoft.icon"),
    });
    const result = await resolveFavicon("hubble-hq.vercel.app", { fetcher });
    expect(result).toMatchObject({
      ok: true,
      contentType: "image/x-icon",
      source: "https://hubble-hq.vercel.app/favicon.ico?favicon.38e20fl_719mw.ico",
    });
  });

  it("skips a declared icon that fails and uses the next working one", async () => {
    const { fetcher } = network({
      "https://flaky.com/": html(`<link rel="icon" href="/gone.svg" type="image/svg+xml"><link rel="icon" href="/ok.png" sizes="32x32">`),
      "https://flaky.com/gone.svg": notFound,
      "https://flaky.com/ok.png": file(PNG),
    });
    expect(await resolveFavicon("flaky.com", { fetcher })).toMatchObject({ ok: true, source: "https://flaky.com/ok.png" });
  });

  it("rejects a soft-404 favicon.ico (HTML served with 200) and a malformed body", async () => {
    const { fetcher } = network({
      "https://soft404.com/": html(`<link rel="icon" href="/broken.png">`),
      "https://soft404.com/broken.png": file(Buffer.from("definitely not a png"), "image/png"),
      "https://soft404.com/favicon.ico": file(HTML_ERROR_PAGE, "text/html"),
    });
    expect(await resolveFavicon("soft404.com", { fetcher })).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports not-found for a reachable site with no favicon at all", async () => {
    const { fetcher } = network({
      "https://no-icon.com/": html("<html><head></head></html>"),
      "https://no-icon.com/favicon.ico": notFound,
    });
    expect(await resolveFavicon("no-icon.com", { fetcher })).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports unreachable when every request fails at the network level", async () => {
    const { fetcher } = network({});
    expect(await resolveFavicon("down.com", { fetcher })).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports not-found for a domain that does not exist at all", async () => {
    const noSuchHost = { ok: false, reason: "no-such-host" } as const;
    const { fetcher } = network({
      "https://gone-domain.com/": noSuchHost,
      "https://www.gone-domain.com/": noSuchHost,
      "http://gone-domain.com/": noSuchHost,
    });
    expect(await resolveFavicon("gone-domain.com", { fetcher })).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports unreachable, not not-found, when a bot wall turns the server away", async () => {
    // Recorded behaviour of stackoverflow.com toward a server-side client:
    // Cloudflare answers 403 for both the page and the icon, while a browser
    // gets the real favicon. "unreachable" is what lets the client try.
    const walled = file(Buffer.from("<html>Just a moment...</html>"), "text/html", 403);
    const { fetcher } = network({
      "https://walled.com/": walled,
      "https://walled.com/favicon.ico": walled,
    });
    expect(await resolveFavicon("walled.com", { fetcher })).toEqual({ ok: false, reason: "unreachable" });

    for (const status of [401, 429, 500, 503]) {
      const other = network({
        "https://flaky-host.com/": html("<html><head></head></html>"),
        "https://flaky-host.com/favicon.ico": file(Buffer.from("err"), "text/plain", status),
      });
      expect(await resolveFavicon("flaky-host.com", { fetcher: other.fetcher }), String(status)).toEqual({
        ok: false,
        reason: "unreachable",
      });
    }
  });

  it("stops at once for a host whose DNS points at a private address", async () => {
    const { fetcher, requested } = network({
      "https://rebind.com/": { ok: false, reason: "blocked" },
    });
    expect(await resolveFavicon("rebind.com", { fetcher })).toEqual({ ok: false, reason: "unreachable" });
    expect(requested).toEqual(["https://rebind.com/"]);
  });

  it("retries a www-only site on www.", async () => {
    const { fetcher } = network({
      "https://www.wwwonly.com/": html(`<link rel="icon" href="/i.png">`),
      "https://www.wwwonly.com/i.png": file(PNG),
    });
    expect(await resolveFavicon("wwwonly.com", { fetcher })).toMatchObject({ ok: true, source: "https://www.wwwonly.com/i.png" });
  });

  it("decodes an inline data: icon", async () => {
    const { fetcher } = network({
      "https://inline.com/": html(`<link rel="icon" href="data:image/png;base64,${PNG.toString("base64")}">`),
    });
    expect(await resolveFavicon("inline.com", { fetcher })).toMatchObject({ ok: true, contentType: "image/png", source: "inline" });
  });

  it("refuses invalid hosts without touching the network", async () => {
    const { fetcher } = network({});
    for (const host of ["localhost", "127.0.0.1", "metadata.google.internal", "x"]) {
      expect(await resolveFavicon(host, { fetcher })).toEqual({ ok: false, reason: "invalid-host" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tries at most five icon candidates per host", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join("");
    const { fetcher, requested } = network({ "https://many.com/": html(links) });
    await resolveFavicon("many.com", { fetcher });
    expect(requested.filter((url) => url !== "https://many.com/")).toHaveLength(5);
  });
});

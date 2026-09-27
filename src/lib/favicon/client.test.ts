import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_RETRY_MS,
  SOURCE_TIMEOUT_MS,
  faviconSources,
  peekFaviconImage,
  peekFaviconSrc,
  reportFaviconBroken,
  requestFavicon,
  resetFaviconCache,
  subscribeFavicons,
} from "./client";
import { installFakeFaviconNetwork, type ImageOutcome, type ServiceOutcome } from "./__fixtures__/fake-network";

const SERVICE = (host: string) => `/api/favicon?host=${host}`;
const DIRECT = (host: string) => `https://${host}/favicon.ico`;

let service: Record<string, ServiceOutcome>;
let images: Record<string, ImageOutcome>;
let net: ReturnType<typeof installFakeFaviconNetwork>;

/** Lets the fake fetch/decode microtasks and the loader's awaits run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  service = {};
  images = {};
  net = installFakeFaviconNetwork({
    service: (host) => service[host] ?? "not-found",
    image: (src) => images[src] ?? "error",
  });
  resetFaviconCache();
});

afterEach(() => {
  resetFaviconCache();
  net.restore();
  vi.useRealTimers();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("faviconSources", () => {
  it("asks Hubble's same-origin resolver, with the site's /favicon.ico as the web's direct fallback", () => {
    expect(faviconSources("console.cloud.google.com", "web")).toEqual({
      service: "/api/favicon?host=console.cloud.google.com",
      direct: "https://console.cloud.google.com/favicon.ico",
    });
  });

  it("asks only the deployed resolver from the desktop app, which has no API routes and a strict CSP", () => {
    expect(faviconSources("hubble-hq.vercel.app", "desktop")).toEqual({
      service: "https://hubble-hq.vercel.app/api/favicon?host=hubble-hq.vercel.app",
      direct: null,
    });
  });

  it("never involves Google's favicon service", () => {
    for (const platform of ["web", "desktop"] as const) {
      expect(JSON.stringify(faviconSources("github.com", platform))).not.toContain("google.com/s2");
    }
  });
});

describe("requestFavicon", () => {
  it("resolves a site through the resolver, as a blob URL, cached for every consumer", async () => {
    service["hubble-hq.vercel.app"] = "icon";
    requestFavicon("hubble-hq.vercel.app");
    expect(peekFaviconSrc("hubble-hq.vercel.app")).toBeNull();
    await settle();

    expect(peekFaviconSrc("hubble-hq.vercel.app")).toMatch(/^blob:/);
    expect(peekFaviconImage("hubble-hq.vercel.app")?.naturalWidth).toBe(32);

    // Cached: more requests (other cards, the canvas every frame) fetch nothing new.
    requestFavicon("hubble-hq.vercel.app");
    requestFavicon("HUBBLE-HQ.vercel.app");
    await settle();
    expect(net.fetched).toEqual([SERVICE("hubble-hq.vercel.app")]);
  });

  it("keys subdomains separately", async () => {
    service["console.cloud.google.com"] = "icon";
    requestFavicon("console.cloud.google.com");
    requestFavicon("cloud.google.com");
    await settle();
    expect(peekFaviconSrc("console.cloud.google.com")).toMatch(/^blob:/);
    expect(peekFaviconSrc("cloud.google.com")).toBeNull();
    expect(net.fetched).toEqual([SERVICE("console.cloud.google.com"), SERVICE("cloud.google.com")]);
  });

  it("stops at 'not-found' — the site was reached and has no icon — without trying it directly", async () => {
    requestFavicon("example.com");
    await settle();
    expect(peekFaviconSrc("example.com")).toBeNull();
    expect(net.images).toEqual([]);
  });

  it("tries the site's /favicon.ico directly when the resolver couldn't reach it", async () => {
    for (const outcome of ["unreachable", "server-error", "offline"] as const) {
      resetFaviconCache();
      const host = `bot-walled-${outcome}.com`;
      service[host] = outcome;
      images[DIRECT(host)] = "load";
      requestFavicon(host);
      await settle();
      expect(peekFaviconSrc(host), outcome).toBe(DIRECT(host));
    }
  });

  it("falls back to the letter when neither the resolver nor the site has an icon", async () => {
    service["dead.com"] = "unreachable";
    requestFavicon("dead.com");
    await settle();
    expect(net.images).toEqual([DIRECT("dead.com")]);
    expect(peekFaviconSrc("dead.com")).toBeNull();
  });

  it("treats verified bytes the browser cannot decode as no icon, and releases the blob", async () => {
    service["weird-ico.com"] = "undecodable";
    requestFavicon("weird-ico.com");
    await settle();
    expect(peekFaviconSrc("weird-ico.com")).toBeNull();
    expect(net.revoked).toHaveLength(1);
  });

  it("gives up on a resolver that never answers, then tries the site directly", async () => {
    service["slow.com"] = "hang";
    images[DIRECT("slow.com")] = "load";
    requestFavicon("slow.com");
    await settle();
    expect(peekFaviconSrc("slow.com")).toBeNull();
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
    expect(peekFaviconSrc("slow.com")).toBe(DIRECT("slow.com"));
  });

  it("gives up on a direct icon that never loads", async () => {
    service["slow-direct.com"] = "unreachable";
    images[DIRECT("slow-direct.com")] = "hang";
    requestFavicon("slow-direct.com");
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 1);
    expect(peekFaviconSrc("slow-direct.com")).toBeNull();
  });

  it("remembers a failure only briefly, so a favicon that appears later is picked up", async () => {
    requestFavicon("late-icon.com");
    await settle();
    expect(peekFaviconSrc("late-icon.com")).toBeNull();
    expect(net.fetched).toHaveLength(1);

    // Within the retry window: no refetch storm from every re-render.
    requestFavicon("late-icon.com");
    await settle();
    expect(net.fetched).toHaveLength(1);

    // The site ships a favicon; after the window, the next request finds it.
    service["late-icon.com"] = "icon";
    await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MS + 1);
    requestFavicon("late-icon.com");
    await settle();
    expect(peekFaviconSrc("late-icon.com")).toMatch(/^blob:/);
  });

  it("retries failed hosts at once when the browser comes back online", async () => {
    service["offline.com"] = "offline";
    requestFavicon("offline.com");
    await settle();
    service["offline.com"] = "icon";
    window.dispatchEvent(new Event("online"));
    requestFavicon("offline.com");
    await settle();
    expect(peekFaviconSrc("offline.com")).toMatch(/^blob:/);
  });

  it("makes no request at all for invalid or reserved domains", async () => {
    for (const domain of ["", "localhost", "192.168.1.1", "docs.hubble.example", "not a domain"]) requestFavicon(domain);
    await settle();
    expect(net.fetched).toEqual([]);
    expect(net.images).toEqual([]);
  });

  it("uses the deployed resolver, and never a direct remote image, in the desktop app", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    service["github.com"] = "icon";
    service["walled.com"] = "unreachable";
    requestFavicon("github.com");
    requestFavicon("walled.com");
    await settle();
    expect(net.fetched).toEqual([
      "https://hubble-hq.vercel.app/api/favicon?host=github.com",
      "https://hubble-hq.vercel.app/api/favicon?host=walled.com",
    ]);
    expect(peekFaviconSrc("github.com")).toMatch(/^blob:/);
    expect(peekFaviconSrc("walled.com")).toBeNull();
    expect(net.images.every((src) => src.startsWith("blob:"))).toBe(true);
  });

  it("notifies subscribers when an icon resolves", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFavicons(listener);
    service["github.com"] = "icon";
    requestFavicon("github.com");
    await settle();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

describe("reportFaviconBroken", () => {
  it("drops a cached icon that later fails to render, and ignores stale reports", async () => {
    service["github.com"] = "icon";
    requestFavicon("github.com");
    await settle();
    const src = peekFaviconSrc("github.com")!;

    reportFaviconBroken("github.com", "blob:some-older-src");
    expect(peekFaviconSrc("github.com")).toBe(src);

    reportFaviconBroken("github.com", src);
    expect(peekFaviconSrc("github.com")).toBeNull();
    expect(net.revoked).toContain(src);
  });
});

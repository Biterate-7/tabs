import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, publicApiUrl, ServerUnavailableError } from "./api-base";
import { sendBrowserCommand, startConnectionWatch, __resetBrowserBridgeForTests } from "@/lib/browser/bridge";
import { DESKTOP_UNREACHABLE } from "@/lib/browser/protocol";
import { fetchBrowserHistory } from "@/lib/browser/history";
import { requestTitles } from "@/lib/titles/client/queue";
import { requestOrganizeCompletion } from "@/lib/sections/ai/client";
import { extractionEndpoint } from "@/lib/resources/process";
import { faviconSources } from "@/lib/favicon/client";
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";

/**
 * What the shared frontend does inside Hubble Desktop, where it is a static
 * bundle served from http://tauri.localhost with no server behind it. That
 * asset server answers ANY unknown path — `/api/titles` included — with the
 * app's own index.html and a 200, so a relative API call there "succeeds"
 * with a web page. These pin the behaviour that replaced it.
 */

function setDesktop(on: boolean) {
  if (on) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

afterEach(() => {
  setDesktop(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetBrowserBridgeForTests();
});

describe("Hubble's own API from desktop", () => {
  it("refuses a same-origin API path instead of letting the bundle answer it", () => {
    setDesktop(true);
    expect(() => apiUrl("/api/titles")).toThrow(ServerUnavailableError);
    setDesktop(false);
    expect(apiUrl("/api/titles")).toBe("/api/titles");
  });

  it("never sends a request for a route the desktop app doesn't have", async () => {
    setDesktop(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const titles = await requestTitles(["https://example.com/a"]);
    const organize = await requestOrganizeCompletion("prompt");

    expect(fetchSpy).not.toHaveBeenCalled();
    // Both land on the failure every caller already falls back from.
    expect(titles).toEqual([{ url: "https://example.com/a", ok: false, reason: "network-error", permanent: false }]);
    expect(organize.ok).toBe(false);
  });

  it("reads public, cookie-free routes from the deployed Hubble, and only those", () => {
    expect(publicApiUrl("/api/resources/extract", "desktop")).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/resources/extract`);
    expect(publicApiUrl("/api/resources/extract", "web")).toBe("/api/resources/extract");
    expect(extractionEndpoint("desktop")).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/resources/extract`);
    expect(extractionEndpoint("web")).toBe("/api/resources/extract");
    expect(faviconSources("github.com", "desktop").service).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/favicon?host=github.com`);
    expect(faviconSources("github.com", "web").service).toBe("/api/favicon?host=github.com");
  });

  it("picks the platform itself when not told", () => {
    setDesktop(true);
    expect(publicApiUrl("/api/favicon")).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/favicon`);
    setDesktop(false);
    expect(publicApiUrl("/api/favicon")).toBe("/api/favicon");
  });
});

describe("the extension's page bridge on desktop", () => {
  it("answers every command at once, without posting to a page nobody listens on", async () => {
    setDesktop(true);
    const post = vi.spyOn(window, "postMessage");
    vi.useFakeTimers();

    const result = await sendBrowserCommand("list_browser_tabs", {}, { timeoutMs: 2500 });

    expect(result).toMatchObject({ ok: false, error: DESKTOP_UNREACHABLE });
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  it("reports history as not connected straight away instead of after its 15 s timeout", async () => {
    setDesktop(true);
    vi.useFakeTimers();
    await expect(fetchBrowserHistory(0)).resolves.toEqual({ ok: false, reason: "not-connected" });
  });

  it("starts no ping loop on desktop", () => {
    setDesktop(true);
    const post = vi.spyOn(window, "postMessage");
    const stop = startConnectionWatch();
    expect(post).not.toHaveBeenCalled();
    stop();
    post.mockRestore();
  });

  it("still waits for the extension on the web", async () => {
    vi.useFakeTimers();
    const pending = sendBrowserCommand("list_browser_tabs", {}, { timeoutMs: 2500 });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
  });
});

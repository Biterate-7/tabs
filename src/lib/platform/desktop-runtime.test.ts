import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, publicApiUrl, ServerUnavailableError } from "./api-base";
import { sendBrowserCommand, startConnectionWatch, subscribeConnection, __resetBrowserBridgeForTests } from "@/lib/browser/bridge";
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

describe("the extension's bridge on desktop", () => {
  /** A Tauri runtime whose commands answer from `answers`; records every call. */
  function tauriAnswering(answers: Record<string, unknown>) {
    const invoke = vi.fn(async (command: string) => answers[command]);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke, transformCallback: () => 0 };
    return invoke;
  }

  it("sends a command over the paired link, never to a page, and may wake Chrome for something the person asked", async () => {
    const invoke = tauriAnswering({ desktop_link_command: { ok: true, result: { tabs: [] } } });
    const post = vi.spyOn(window, "postMessage");
    const result = await sendBrowserCommand("list_browser_tabs", {}, { timeoutMs: 2500 });
    expect(result).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(invoke).toHaveBeenCalledWith("desktop_link_command", { action: "list_browser_tabs", args: {}, timeoutMs: 12000, wake: true }, undefined);
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  it("never wakes Chrome for a read Hubble makes by itself", async () => {
    const invoke = tauriAnswering({ desktop_link_command: { ok: false, error: "extension-unreachable" } });
    const result = await sendBrowserCommand("get_context_activity", { account: null }, { background: true });
    expect(result).toMatchObject({ ok: false, error: DESKTOP_UNREACHABLE });
    expect(invoke).toHaveBeenCalledWith("desktop_link_command", { action: "get_context_activity", args: { account: null }, timeoutMs: 3000, wake: false }, undefined);
  });

  it("answers as unreachable when nothing is paired, so callers fall back", async () => {
    tauriAnswering({ desktop_link_command: { ok: false, error: "not-paired" } });
    await expect(sendBrowserCommand("open_session", { requestId: "r", tabs: [] })).resolves.toMatchObject({ ok: false, error: DESKTOP_UNREACHABLE });
  });

  it("says a collected command that never came back timed out, and passes the extension's own refusal on", async () => {
    tauriAnswering({ desktop_link_command: { ok: false, error: "timed-out" } });
    await expect(sendBrowserCommand("list_browser_tabs", {})).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
    tauriAnswering({ desktop_link_command: { ok: false, error: "Only Hubble can ask for this." } });
    await expect(sendBrowserCommand("list_browser_tabs", {})).resolves.toMatchObject({ ok: false, error: "Only Hubble can ask for this." });
  });

  it("reads history over the link, and says not-connected when no extension answered", async () => {
    tauriAnswering({ desktop_link_command: { ok: true, result: { items: [{ url: "https://example.com" }] } } });
    await expect(fetchBrowserHistory(0)).resolves.toEqual({ ok: true, items: [{ url: "https://example.com" }] });
    tauriAnswering({ desktop_link_command: { ok: false, error: "extension-unreachable" } });
    await expect(fetchBrowserHistory(0)).resolves.toEqual({ ok: false, reason: "not-connected" });
  });

  it("starts no ping loop on desktop: connected means a Hubble for Chrome is paired", async () => {
    const invoke = tauriAnswering({ desktop_link_paired: true });
    const post = vi.spyOn(window, "postMessage");
    const changes: boolean[] = [];
    const unsubscribe = subscribeConnection((connected) => changes.push(connected));
    const stop = startConnectionWatch();
    await vi.waitFor(() => expect(changes).toEqual([true]));
    expect(invoke).toHaveBeenCalledWith("desktop_link_paired", {}, undefined);
    expect(post).not.toHaveBeenCalled();
    stop();
    unsubscribe();
    post.mockRestore();
  });

  it("still waits for the extension on the web", async () => {
    vi.useFakeTimers();
    const pending = sendBrowserCommand("list_browser_tabs", {}, { timeoutMs: 2500 });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
  });
});

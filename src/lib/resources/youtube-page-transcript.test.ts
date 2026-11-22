import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ sendBrowserCommand: vi.fn(), isBrowserConnected: vi.fn(() => true) }));
vi.mock("@/lib/browser/bridge", () => bridge);

import { getContent, putContent, resetContentStoreForTests } from "./content-store";
import { EXTRACTION_ERRORS } from "./extraction";
import { ingestResources } from "./ingest";
import { browserTranscriptError, processSource, RECENT_ACTION_MS } from "./process";
import { searchProject } from "./search";
import { BROWSER_TRANSCRIPT_BACKGROUND_TIMEOUT_MS, BROWSER_TRANSCRIPT_TIMEOUT_MS, readBrowserTranscript, readTranscriptThroughBrowser, requestYouTubeAccess } from "./youtube-browser";
import { DESKTOP_UNREACHABLE } from "@/lib/browser/protocol";
import { setStorageNamespace } from "@/lib/storage/namespace";
import type { ExtractionResponse } from "./extraction";
import type { ProcessDeps } from "./process";
import type { BrowserTranscript, BrowserTranscriptFailure } from "./youtube-browser";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * Hubble Desktop's YouTube transcripts: read from YouTube's own page in
 * Chrome (Hubble for Chrome), when the deployed reader has none — which,
 * with no paid reader service behind it, is always.
 */

const NOW = 1_800_000_000_000;
const ID = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

function videoTab(url = WATCH): Tab {
  const store: WorkspaceStore = { version: 1, currentId: "p", workspaces: [{ id: "p", name: "Music", tabs: [], sections: [], createdAt: 1, updatedAt: 1 }] };
  return ingestResources(store, "p", [{ url }], "manual", NOW)!.store.workspaces[0]!.tabs[0]!;
}

/** What the deployed reader answers today: the video's metadata, and no transcript (no reader service is set up). */
const SITE_WITHOUT_TRANSCRIPT: ExtractionResponse = {
  ok: true,
  kind: "youtube",
  status: "partial",
  finalUrl: WATCH,
  title: "Never Gonna Give You Up",
  meta: { siteName: "YouTube", author: "Rick Astley" },
  error: EXTRACTION_ERRORS.transcripts_off,
};

const PAGE: BrowserTranscript = {
  ok: true,
  segments: [
    { start: 18, text: "We're no strangers to love" },
    { start: 43, text: "Never gonna give you up" },
  ],
  title: "Page title",
  channel: "Rick Astley",
};

function deps(site: ExtractionResponse | (() => Promise<ExtractionResponse>), page?: BrowserTranscript | (() => Promise<BrowserTranscript>), now = NOW + 5) {
  const readTranscript = vi.fn(async () => (typeof page === "function" ? page() : (page ?? PAGE)));
  const extract = vi.fn(async () => (typeof site === "function" ? site() : site));
  const all: ProcessDeps = { extract, putContent, now: () => now, readTranscript };
  return { deps: all, readTranscript, extract };
}

beforeEach(() => {
  resetContentStoreForTests();
  setStorageNamespace(null);
  bridge.sendBrowserCommand.mockReset();
  bridge.isBrowserConnected.mockReset().mockReturnValue(true);
});

describe("a saved video's transcript, from YouTube's page", () => {
  it("is read when the reader has none, stored on this device, and the video says ready", async () => {
    const tab = videoTab();
    const { deps: d, readTranscript } = deps(SITE_WITHOUT_TRANSCRIPT);
    const result = await processSource("p", tab, d);
    expect(readTranscript).toHaveBeenCalledWith({ videoId: ID, wake: true });
    expect(result.resource).toMatchObject({ status: "ready", meta: { siteName: "YouTube", author: "Rick Astley" }, content: { transcriptLines: 2 } });
    expect(result.resource.error).toBeUndefined();
    // The reader's title wins over the page's; the page's is only a fallback.
    expect(result.title).toBe("Never Gonna Give You Up");
    const stored = await getContent("p", tab.id);
    expect(stored?.transcript).toEqual([
      { start: 18, text: "We're no strangers to love" },
      { start: 43, text: "Never gonna give you up" },
    ]);
    expect(stored?.transcriptInfo).toEqual({ source: "captions", provider: "youtube" });
  });

  it("is searchable by what is said, at the moment it is said", async () => {
    const tab = videoTab();
    const result = await processSource("p", tab, deps(SITE_WITHOUT_TRANSCRIPT).deps);
    const contents = new Map([[tab.id, (await getContent("p", tab.id))!]]);
    const hits = searchProject({ query: "strangers to love", tabs: [{ ...tab, resource: result.resource }], contents });
    expect(hits.find((hit) => hit.location.kind === "transcript")).toMatchObject({ type: "source", tabId: tab.id, location: { kind: "transcript", line: 0, start: 18 } });
  });

  it("is not asked for when the reader already brought one", async () => {
    const tab = videoTab();
    const site: ExtractionResponse = { ...SITE_WITHOUT_TRANSCRIPT, status: "ready", error: undefined, content: { transcript: [{ start: 1, text: "from the reader" }], transcriptInfo: { source: "captions", provider: "supadata" } } };
    const { deps: d, readTranscript } = deps(site);
    expect((await processSource("p", tab, d)).resource.status).toBe("ready");
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("is not asked for a video the reader found gone — there is nothing to open", async () => {
    const tab = videoTab();
    const { deps: d, readTranscript } = deps({ ...SITE_WITHOUT_TRANSCRIPT, error: EXTRACTION_ERRORS.video_unavailable });
    expect((await processSource("p", tab, d)).resource).toMatchObject({ status: "partial", error: EXTRACTION_ERRORS.video_unavailable });
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("still arrives when the deployed reader can't be reached, with the page's own title", async () => {
    const tab = videoTab();
    const { deps: d } = deps({ ok: false, error: EXTRACTION_ERRORS.offline });
    const result = await processSource("p", tab, d);
    expect(result.resource).toMatchObject({ status: "ready", meta: { siteName: "YouTube", author: "Rick Astley" } });
    expect(result.title).toBe("Page title");
    const threw = deps(() => Promise.reject(new Error("network")));
    expect((await processSource("p", videoTab(), threw.deps)).resource.status).toBe("ready");
  });

  it("wakes Chrome only for something the person just did — never for a read Hubble starts by itself", async () => {
    const fresh = deps(SITE_WITHOUT_TRANSCRIPT);
    await processSource("p", videoTab(), fresh.deps);
    expect(fresh.readTranscript).toHaveBeenCalledWith({ videoId: ID, wake: true });
    const later = deps(SITE_WITHOUT_TRANSCRIPT, PAGE, NOW + RECENT_ACTION_MS + 1);
    await processSource("p", videoTab(), later.deps);
    expect(later.readTranscript).toHaveBeenCalledWith({ videoId: ID, wake: false });
  });

  it("never says the transcripts 'aren't set up' — every outcome says what really happened", async () => {
    const reasons: BrowserTranscriptFailure[] = ["no_transcript", "video_unavailable", "no_access", "no_extension", "no_answer", "outdated", "not_loaded", "timeout", "failed"];
    for (const reason of reasons) {
      const result = await processSource("p", videoTab(), deps(SITE_WITHOUT_TRANSCRIPT, { ok: false, reason }).deps);
      expect(result.resource.status, reason).toBe("partial");
      expect(result.resource.error, reason).toEqual(browserTranscriptError(reason));
      expect(result.resource.error?.message, reason).not.toMatch(/aren't set up/);
      expect(result.resource.content, reason).toBeUndefined();
    }
  });

  it("is unavailable (not retried) only when YouTube itself says so; anything else can be tried again", () => {
    expect(browserTranscriptError("no_transcript")).toMatchObject({ code: "transcript_unavailable", retryable: false });
    expect(browserTranscriptError("video_unavailable")).toMatchObject({ code: "not_found", retryable: false });
    expect(browserTranscriptError("no_access")).toMatchObject({ code: "needs_access", retryable: true });
    for (const reason of ["no_extension", "no_answer", "outdated"] as const) expect(browserTranscriptError(reason)).toMatchObject({ code: "needs_extension", retryable: true });
    for (const reason of ["not_loaded", "timeout", "failed"] as const) expect(browserTranscriptError(reason).retryable).toBe(true);
  });

  it("is a failure to retry, not a saved video, when neither the reader nor the page could tell anything", async () => {
    const result = await processSource("p", videoTab(), deps({ ok: false, error: EXTRACTION_ERRORS.offline }, { ok: false, reason: "no_answer" }).deps);
    expect(result.resource).toMatchObject({ status: "failed", error: EXTRACTION_ERRORS.offline });
    const definite = await processSource("p", videoTab(), deps({ ok: false, error: EXTRACTION_ERRORS.offline }, { ok: false, reason: "no_transcript" }).deps);
    expect(definite.resource).toMatchObject({ status: "partial", error: EXTRACTION_ERRORS.transcript_unavailable });
  });

  it("keeps a transcript the person added when the page has none", async () => {
    const tab = videoTab();
    await putContent("p", tab.id, { kind: "youtube", transcript: [{ text: "mine" }], transcriptInfo: { source: "supplied" }, extractedAt: 1 });
    const withMine = { ...tab, resource: { ...tab.resource!, content: { chars: 4, transcriptLines: 1, extractedAt: 1 } } };
    const result = await processSource("p", withMine, deps(SITE_WITHOUT_TRANSCRIPT, { ok: false, reason: "no_answer" }).deps);
    expect(result.resource.status).toBe("ready");
    expect((await getContent("p", tab.id))?.transcriptInfo).toEqual({ source: "supplied" });
  });

  it("is a failure, never a crash, when asking throws", async () => {
    const result = await processSource("p", videoTab(), deps(SITE_WITHOUT_TRANSCRIPT, () => Promise.reject(new Error("bridge"))).deps);
    expect(result.resource).toMatchObject({ status: "partial", error: EXTRACTION_ERRORS.transcript_read_failed });
  });
});

describe("asking Hubble for Chrome", () => {
  it("sends only the video id: a long wait (and a wake) for the person's own action, a short one in the background", async () => {
    bridge.sendBrowserCommand.mockResolvedValue({ id: "1", ok: true, result: { ok: true, videoId: ID, segments: [{ start: 1, text: "hi" }] } });
    await readTranscriptThroughBrowser({ videoId: ID, wake: true });
    expect(bridge.sendBrowserCommand).toHaveBeenLastCalledWith("read_youtube_transcript", { videoId: ID }, { timeoutMs: BROWSER_TRANSCRIPT_TIMEOUT_MS });
    await readTranscriptThroughBrowser({ videoId: ID, wake: false });
    expect(bridge.sendBrowserCommand).toHaveBeenLastCalledWith("read_youtube_transcript", { videoId: ID }, { background: true, timeoutMs: BROWSER_TRANSCRIPT_BACKGROUND_TIMEOUT_MS });
    expect(await readTranscriptThroughBrowser({ videoId: "../../etc", wake: true })).toEqual({ ok: false, reason: "failed" });
    expect(bridge.sendBrowserCommand).toHaveBeenCalledTimes(2);
  });

  it.each([
    [DESKTOP_UNREACHABLE, true, "no_answer"],
    [DESKTOP_UNREACHABLE, false, "no_extension"],
    ['Unknown or disallowed browser action "read_youtube_transcript".', true, "outdated"],
    ["Hubble Desktop doesn't ask Chrome that.", true, "outdated"],
    ["Timed out waiting for the browser extension to respond.", true, "timeout"],
    ["busy", true, "failed"],
  ] as const)("reads the link's %s (connected: %s) as %s", async (error, connected, reason) => {
    bridge.isBrowserConnected.mockReturnValue(connected);
    bridge.sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error });
    expect(await readTranscriptThroughBrowser({ videoId: ID, wake: true })).toEqual({ ok: false, reason });
  });

  it("re-reads every answer: cleaned lines, known reasons only, and never an empty transcript", () => {
    expect(readBrowserTranscript({ ok: true, segments: [{ start: 43, text: " b " }, { start: 18, text: "a" }], channel: " C ", title: "" })).toEqual({
      ok: true,
      segments: [
        { start: 18, text: "a" },
        { start: 43, text: "b" },
      ],
      channel: "C",
    });
    expect(readBrowserTranscript({ ok: true, segments: [{ text: "" }] })).toEqual({ ok: false, reason: "no_transcript" });
    expect(readBrowserTranscript({ ok: true, segments: "x" })).toEqual({ ok: false, reason: "failed" });
    expect(readBrowserTranscript({ ok: false, reason: "no-access" })).toEqual({ ok: false, reason: "no_access" });
    expect(readBrowserTranscript({ ok: false, reason: "video-unavailable" })).toEqual({ ok: false, reason: "video_unavailable" });
    expect(readBrowserTranscript({ ok: false, reason: "toString" })).toEqual({ ok: false, reason: "failed" });
    expect(readBrowserTranscript(null)).toEqual({ ok: false, reason: "failed" });
  });

  it("asks for youtube.com access and reports Chrome's answer", async () => {
    bridge.sendBrowserCommand.mockResolvedValue({ id: "1", ok: true, result: { granted: true } });
    expect(await requestYouTubeAccess()).toEqual({ granted: true });
    expect(bridge.sendBrowserCommand).toHaveBeenLastCalledWith("request_youtube_access", {}, { timeoutMs: 120_000 });
    bridge.sendBrowserCommand.mockResolvedValue({ id: "1", ok: true, result: { granted: false, answer: "denied" } });
    expect(await requestYouTubeAccess()).toEqual({ granted: false });
    bridge.isBrowserConnected.mockReturnValue(false);
    bridge.sendBrowserCommand.mockResolvedValue({ id: "1", ok: false, error: DESKTOP_UNREACHABLE });
    expect(await requestYouTubeAccess()).toEqual({ granted: false, reason: "no_extension" });
  });
});

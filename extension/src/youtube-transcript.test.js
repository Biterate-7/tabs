// The YouTube transcript reader, run against page fixtures shaped like YouTube's
// markup as seen live on 2026-11-22 (the "In this video" panel's
// transcript-segment-view-model, the untagged panel a video with chapters
// opens, the older ytd-transcript-segment-renderer, and the "unavailable" and
// "no transcript" pages). Fixtures hold the code to the structure it was
// written for; the failure paths answer with a reason, never an empty transcript.
import { describe, expect, it, vi } from "vitest";
import {
  YOUTUBE_ACCESS,
  createYouTubeTranscriptReader,
  isVideoId,
  readTranscriptAnswer,
  readYouTubeTranscriptFromPage,
  watchUrlOf,
  watchedVideoIdOf,
} from "./youtube-transcript.js";
import { youtubeVideoId } from "../../src/lib/resources/detect";
import manifest from "../manifest.json";

const ID = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

function modernSegment(time, text) {
  return `<macro-markers-panel-item-view-model><timeline-item-view-model><div><transcript-segment-view-model><div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">${time}</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">${time} label</div><span class="ytAttributedStringHost" role="text">${text}</span></transcript-segment-view-model></div></timeline-item-view-model></macro-markers-panel-item-view-model>`;
}

function legacySegment(time, text) {
  return `<ytd-transcript-segment-renderer><div class="segment-timestamp">${time}</div><yt-formatted-string class="segment-text">${text}</yt-formatted-string></ytd-transcript-segment-renderer>`;
}

/** A watch page. `panel` is the transcript panel's markup and state; `onShow` runs when "Show transcript" is clicked. */
function watchPage({ videoId = ID, metadata = true, unavailable = false, button = true, panels = ["PAmodern_transcript_view"], openPanel, onShow } = {}) {
  const doc = document.implementation.createHTMLDocument("YouTube");
  const flexyAttrs = [videoId ? `video-id="${videoId}"` : "", metadata ? "has-metadata" : "", unavailable ? "player-unavailable" : ""].join(" ");
  doc.body.innerHTML = `
    <ytd-watch-flexy ${flexyAttrs}>
      <video></video>
      <yt-playability-error-supported-renderers ${unavailable ? "" : "hidden"}>${unavailable ? "Video unavailable This video is unavailable" : ""}</yt-playability-error-supported-renderers>
      <ytd-watch-metadata><h1>Never Gonna Give You Up</h1><ytd-channel-name><div id="text"><a href="/@RickAstley">Rick Astley</a></div><tp-yt-paper-tooltip>Rick Astley</tp-yt-paper-tooltip></ytd-channel-name></ytd-watch-metadata>
      ${button ? `<ytd-video-description-transcript-section-renderer><button aria-label="Show transcript">Show transcript</button></ytd-video-description-transcript-section-renderer>` : ""}
      ${panels.map((id) => `<ytd-engagement-panel-section-list-renderer target-id="${id}" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div id="visibility-button"><button aria-label="Close transcript"></button></div><div id="content"></div></ytd-engagement-panel-section-list-renderer>`).join("")}
      ${openPanel ?? ""}
    </ytd-watch-flexy>`;
  const video = doc.querySelector("video");
  video.pause = vi.fn();
  for (const close of doc.querySelectorAll("#visibility-button button")) {
    close.addEventListener("click", () => close.closest("ytd-engagement-panel-section-list-renderer").setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"));
  }
  doc.querySelector("ytd-video-description-transcript-section-renderer button")?.addEventListener("click", () => onShow?.(doc));
  return doc;
}

/** Opens the modern panel with `segments` on the next tick, as YouTube does after its own fetch. */
function showsModern(segments) {
  return (doc) =>
    setTimeout(() => {
      const panel = doc.querySelector('[target-id="PAmodern_transcript_view"]');
      panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      panel.querySelector("#content").innerHTML = segments.join("");
    }, 5);
}

function env(doc, href = WATCH) {
  return { document: doc, href, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) };
}

describe("which tabs are YouTube videos", () => {
  it.each([
    [WATCH, ID],
    [`https://youtube.com/watch?v=${ID}&t=42s`, ID],
    [`https://www.youtube.com/watch?v=${ID}&list=PL123`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, undefined],
    [`https://www.youtube.com/shorts/${ID}`, undefined],
    [`https://youtu.be/${ID}`, undefined],
    [`http://www.youtube.com/watch?v=${ID}`, undefined],
    ["https://www.youtube.com/watch?v=short", undefined],
    [`https://www.youtube.com.evil.example/watch?v=${ID}`, undefined],
    ["not a url", undefined],
  ])("reads %s as a watch page of %s", (url, expected) => {
    expect(watchedVideoIdOf(url)).toBe(expected);
  });

  it("agrees with the web app's id for every watch page it reads", () => {
    for (const url of [WATCH, `https://youtube.com/watch?v=${ID}&t=42s`]) expect(watchedVideoIdOf(url)).toBe(youtubeVideoId(url));
  });

  it("opens only an address rebuilt from the id", () => {
    expect(watchUrlOf(ID)).toBe(WATCH);
    expect(isVideoId(ID)).toBe(true);
    for (const bad of ["", "abc", `${ID}x`, "dQw4w9WgXc/", null, 42]) expect(isVideoId(bad)).toBe(false);
  });

  it("asks for exactly the optional permission the manifest declares", () => {
    for (const origin of YOUTUBE_ACCESS.origins) expect(manifest.optional_host_permissions).toContain(origin);
    expect(manifest.host_permissions).not.toContain("https://www.youtube.com/*");
  });
});

describe("reading the transcript YouTube shows", () => {
  it("opens the panel with YouTube's own button, reads every line with its time, and closes it again", async () => {
    const doc = watchPage({ onShow: showsModern([modernSegment("0:01", "[♪♪♪]"), modernSegment("0:18", "We're no strangers to love"), modernSegment("1:02:03", "  much   later  ")]) });
    const answer = await readYouTubeTranscriptFromPage(ID, { waitMs: 2000, pollMs: 5 }, env(doc));
    expect(answer).toEqual({
      ok: true,
      videoId: ID,
      segments: [
        { start: 1, text: "[♪♪♪]" },
        { start: 18, text: "We're no strangers to love" },
        { start: 3723, text: "much later" },
      ],
      title: "Never Gonna Give You Up",
      channel: "Rick Astley",
    });
    expect(doc.querySelector('[target-id="PAmodern_transcript_view"]').getAttribute("visibility")).toBe("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  });

  it("reads a panel the person already has open, and leaves it open", async () => {
    const open = `<ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">${modernSegment("0:05", "already open")}</ytd-engagement-panel-section-list-renderer>`;
    const doc = watchPage({ panels: [], openPanel: open, onShow: () => expect.unreachable("no click needed") });
    const answer = await readYouTubeTranscriptFromPage(ID, { waitMs: 500, pollMs: 5 }, env(doc));
    expect(answer).toMatchObject({ ok: true, segments: [{ start: 5, text: "already open" }] });
    expect(doc.querySelector('[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]')).not.toBeNull();
  });

  it("reads a video with chapters, whose 'In this video' panel has no transcript id and may open on Chapters", async () => {
    const chapters = `<ytd-engagement-panel-section-list-renderer visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div id="visibility-button"><button aria-label="Close"></button></div><button aria-label="Chapters" aria-selected="true">Chapters</button><button aria-label="Transcript" aria-selected="false">Transcript</button><div id="list"><timeline-chapter-view-model>Intro</timeline-chapter-view-model></div></ytd-engagement-panel-section-list-renderer>`;
    const doc = watchPage({
      openPanel: chapters,
      onShow: (page) => page.querySelector("ytd-engagement-panel-section-list-renderer:not([target-id])").setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"),
    });
    const panel = doc.querySelector("ytd-engagement-panel-section-list-renderer:not([target-id])");
    panel.querySelector('[aria-label="Close"]').addEventListener("click", () => panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"));
    panel.querySelector('[aria-label="Transcript"]').addEventListener("click", (event) => {
      event.currentTarget.setAttribute("aria-selected", "true");
      panel.querySelector("#list").innerHTML = `<timeline-chapter-view-model>Intro</timeline-chapter-view-model>${modernSegment("0:00", "hi everyone")}${modernSegment("1:56:13", "see you later")}`;
    });
    const answer = await readYouTubeTranscriptFromPage(ID, { waitMs: 2000, pollMs: 5 }, env(doc));
    expect(answer).toMatchObject({ ok: true, segments: [{ start: 0, text: "hi everyone" }, { start: 6973, text: "see you later" }] });
    expect(panel.getAttribute("visibility")).toBe("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  });

  it("reads YouTube's older transcript panel too", async () => {
    const doc = watchPage({
      panels: ["engagement-panel-searchable-transcript"],
      onShow: (page) => {
        const panel = page.querySelector('[target-id="engagement-panel-searchable-transcript"]');
        panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        panel.querySelector("#content").innerHTML = `${legacySegment("0:07", "legacy line")}<ytd-transcript-footer-renderer><div id="label-text">English (auto-generated)</div></ytd-transcript-footer-renderer>`;
      },
    });
    const answer = await readYouTubeTranscriptFromPage(ID, { waitMs: 1000, pollMs: 5 }, env(doc));
    expect(answer).toMatchObject({ ok: true, segments: [{ start: 7, text: "legacy line" }], track: "English (auto-generated)" });
  });

  it("pauses the video only when asked (a tab Hubble opened), never the person's own", async () => {
    const mine = watchPage({ onShow: showsModern([modernSegment("0:01", "a")]) });
    await readYouTubeTranscriptFromPage(ID, { waitMs: 1000, pollMs: 5 }, env(mine));
    expect(mine.querySelector("video").pause).not.toHaveBeenCalled();
    const opened = watchPage({ onShow: showsModern([modernSegment("0:01", "a")]) });
    await readYouTubeTranscriptFromPage(ID, { waitMs: 1000, pollMs: 5, pause: true }, env(opened));
    expect(opened.querySelector("video").pause).toHaveBeenCalled();
  });

  it("says no-transcript only when the page has loaded and offers none", async () => {
    const doc = watchPage({ button: false, panels: ["engagement-panel-structured-description"] });
    const t0 = Date.now();
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 3000, pollMs: 5 }, { ...env(doc), now: () => Date.now() + (Date.now() - t0) * 200 })).toEqual({ ok: false, reason: "no-transcript" });
  });

  it("says video-unavailable when YouTube shows the video as private, removed or restricted", async () => {
    const doc = watchPage({ videoId: "", metadata: false, unavailable: true, button: false, panels: [] });
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 1000, pollMs: 5 }, env(doc))).toEqual({ ok: false, reason: "video-unavailable" });
  });

  it("says not-loaded, never no-transcript, when the page or its panel doesn't finish", async () => {
    const neverLoads = watchPage({ metadata: false });
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 30, pollMs: 5 }, env(neverLoads))).toEqual({ ok: false, reason: "not-loaded" });
    const panelWithoutButton = watchPage({ button: false });
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 30, pollMs: 5 }, env(panelWithoutButton))).toEqual({ ok: false, reason: "not-loaded" });
    const panelNeverFills = watchPage({ onShow: () => {} });
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 60, pollMs: 5 }, env(panelNeverFills))).toEqual({ ok: false, reason: "not-loaded" });
  });

  it("reads only the video it was asked for", async () => {
    const doc = watchPage({ onShow: showsModern([modernSegment("0:01", "a")]) });
    expect(await readYouTubeTranscriptFromPage(ID, {}, env(doc, "https://www.youtube.com/watch?v=aaaaaaaaaaa"))).toEqual({ ok: false, reason: "wrong-page" });
    expect(await readYouTubeTranscriptFromPage(ID, {}, env(doc, "https://example.com/watch?v=" + ID))).toEqual({ ok: false, reason: "wrong-page" });
    // The page has moved on to another video (YouTube navigates without reloading).
    const other = watchPage({ videoId: "aaaaaaaaaaa" });
    expect(await readYouTubeTranscriptFromPage(ID, { waitMs: 30, pollMs: 5 }, env(other))).toEqual({ ok: false, reason: "not-loaded" });
  });

  it("has no references outside itself, so executeScript can carry it", () => {
    const source = readYouTubeTranscriptFromPage.toString();
    for (const name of ["YOUTUBE_", "watchUrlOf", "isVideoId", "readTranscriptAnswer"]) expect(source).not.toContain(name);
  });
});

describe("what a page answered, re-checked", () => {
  it("passes on a clean transcript for the video asked about", () => {
    expect(readTranscriptAnswer({ ok: true, videoId: ID, segments: [{ start: 1, text: " a " }, { text: "b" }], title: "T", channel: "C" }, ID)).toEqual({
      ok: true,
      videoId: ID,
      segments: [{ start: 1, text: "a" }, { text: "b" }],
      title: "T",
      channel: "C",
    });
  });

  it("refuses another video's answer, malformed lines and unknown reasons", () => {
    expect(readTranscriptAnswer({ ok: true, videoId: "aaaaaaaaaaa", segments: [{ text: "x" }] }, ID)).toEqual({ ok: false, reason: "read-failed" });
    expect(readTranscriptAnswer({ ok: true, videoId: ID, segments: "nope" }, ID)).toEqual({ ok: false, reason: "read-failed" });
    expect(readTranscriptAnswer({ ok: true, videoId: ID, segments: [{ text: "" }, { start: 5 }, null] }, ID)).toEqual({ ok: false, reason: "no-transcript" });
    expect(readTranscriptAnswer({ ok: false, reason: "drop table" }, ID)).toEqual({ ok: false, reason: "read-failed" });
    expect(readTranscriptAnswer(undefined, ID)).toEqual({ ok: false, reason: "read-failed" });
    expect(readTranscriptAnswer({ ok: true, videoId: ID, segments: [{ start: -1, text: "a" }, { start: Infinity, text: "b" }] }, ID).segments).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("bounds what it passes on", () => {
    const segments = Array.from({ length: 20050 }, (_, index) => ({ start: index, text: "x".repeat(3000) }));
    const answer = readTranscriptAnswer({ ok: true, videoId: ID, segments }, ID);
    expect(answer.segments).toHaveLength(20000);
    expect(answer.segments[0].text).toHaveLength(2000);
  });
});

describe("choosing the tab to read", () => {
  const TRANSCRIPT = { ok: true, videoId: ID, segments: [{ start: 1, text: "hello" }] };

  function chrome({ open = [], access = true, inject = async () => TRANSCRIPT, loads = true, visits = [] } = {}) {
    const created = [];
    const removed = [];
    const deleted = [];
    let nextId = 100;
    const tabs = {
      query: vi.fn(async () => open),
      create: vi.fn(async (props) => {
        const tab = { id: nextId++, url: props.url, status: loads ? "complete" : "loading", active: props.active };
        created.push(tab);
        return tab;
      }),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async (id) => removed.push(id)),
      get: vi.fn(async (id) => created.find((tab) => tab.id === id) ?? open.find((tab) => tab.id === id)),
    };
    const history = { getVisits: vi.fn(async () => visits), deleteUrl: vi.fn(async ({ url }) => deleted.push(url)) };
    const injectSpy = vi.fn(inject);
    const reader = createYouTubeTranscriptReader({
      tabs,
      inject: injectSpy,
      hasAccess: async () => access,
      history,
      sleep: () => Promise.resolve(),
      timing: { loadMs: 50, pageMs: 1000, pollMs: 1 },
    });
    return { reader, tabs, inject: injectSpy, created, removed, deleted, history };
  }

  it("reads a tab already showing the video — the one in front first — and opens nothing", async () => {
    const env = chrome({ open: [{ id: 1, url: WATCH, active: false }, { id: 2, url: `${WATCH}&t=5`, active: true }, { id: 3, url: WATCH, incognito: true }] });
    expect(await env.reader.read(ID)).toEqual({ ...TRANSCRIPT, via: "open-tab" });
    expect(env.inject).toHaveBeenCalledTimes(1);
    expect(env.inject.mock.calls[0][0]).toBe(2);
    expect(env.inject.mock.calls[0][2]).not.toHaveProperty("pause");
    expect(env.tabs.create).not.toHaveBeenCalled();
  });

  it("never reads a private window's tab", async () => {
    const env = chrome({ open: [{ id: 3, url: WATCH, incognito: true }], access: false });
    expect(await env.reader.read(ID)).toEqual({ ok: false, reason: "no-access" });
    expect(env.inject).not.toHaveBeenCalled();
  });

  it("otherwise opens a muted background tab at the video, reads it paused, and closes it", async () => {
    const env = chrome();
    expect(await env.reader.read(ID)).toEqual({ ...TRANSCRIPT, via: "background-tab" });
    expect(env.tabs.create).toHaveBeenCalledWith({ url: WATCH, active: false });
    expect(env.tabs.update).toHaveBeenCalledWith(100, { muted: true });
    expect(env.inject.mock.calls[0][2]).toMatchObject({ pause: true });
    expect(env.removed).toEqual([100]);
  });

  it("takes its own visit back out of Chrome's history, but never a visit the person made", async () => {
    const fresh = chrome({ visits: [{ visitTime: Date.now() + 5 }] });
    await fresh.reader.read(ID);
    expect(fresh.deleted).toEqual([WATCH]);
    const visitedBefore = chrome({ visits: [{ visitTime: 1 }, { visitTime: Date.now() + 5 }] });
    await visitedBefore.reader.read(ID);
    expect(visitedBefore.deleted).toEqual([]);
  });

  it("opens nothing without the person's permission for youtube.com", async () => {
    const env = chrome({ access: false });
    expect(await env.reader.read(ID)).toEqual({ ok: false, reason: "no-access" });
    expect(env.tabs.create).not.toHaveBeenCalled();
  });

  it("falls back to a background tab when an open tab can't be read", async () => {
    let call = 0;
    const env = chrome({
      open: [{ id: 1, url: WATCH, active: true }],
      inject: async () => {
        call += 1;
        if (call === 1) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
        return TRANSCRIPT;
      },
    });
    expect(await env.reader.read(ID)).toEqual({ ...TRANSCRIPT, via: "background-tab" });
  });

  it("closes its tab and says not-loaded when the page doesn't load in time", async () => {
    const env = chrome({ loads: false });
    expect(await env.reader.read(ID)).toEqual({ ok: false, reason: "not-loaded" });
    expect(env.removed).toEqual([100]);
    expect(env.inject).not.toHaveBeenCalled();
  });

  it("reads one video at a time, and a video already being read only once", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const order = [];
    const env = chrome({
      inject: async (tabId, videoId) => {
        order.push(`start ${videoId}`);
        if (videoId === ID) await gate;
        order.push(`end ${videoId}`);
        return { ok: true, videoId, segments: [{ text: videoId }] };
      },
    });
    const first = env.reader.read(ID);
    const again = env.reader.read(ID);
    const second = env.reader.read("aaaaaaaaaaa");
    expect(again).toBe(first);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([`start ${ID}`, `end ${ID}`, "start aaaaaaaaaaa", "end aaaaaaaaaaa"]);
    expect(env.inject).toHaveBeenCalledTimes(2);
  });

  it("answers with a reason, never throws", async () => {
    expect(await chrome().reader.read("not-an-id")).toEqual({ ok: false, reason: "invalid" });
    const broken = chrome({ inject: async () => ({ ok: false, reason: "wrong-page" }) });
    expect(await broken.reader.read(ID)).toEqual({ ok: false, reason: "not-loaded" });
    const throws = chrome({ inject: async () => Promise.reject(new Error("boom")) });
    expect(await throws.reader.read(ID)).toEqual({ ok: false, reason: "read-failed" });
  });
});

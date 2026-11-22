// A YouTube video's transcript, read from YouTube's own page in this Chrome.
//
// ## Why from the page
//
// YouTube shows a transcript under every video that has captions — the
// description's "Show transcript", which opens the "In this video" panel with
// one timed line per caption. Hubble Desktop has no way to get those lines
// itself: YouTube serves caption files only to its own player (with a
// bot-check token Hubble must not forge), and its transcript service is a
// private API Hubble does not call. So Hubble reads them the way a person
// would copy them: it opens that panel on the video's page in this browser,
// reads the lines YouTube has rendered, and closes it again.
//
// Nothing here asks YouTube for anything the page doesn't: no request is
// made by this code, no cookie or token is read, and a video YouTube won't
// show (private, removed, age- or region-restricted) is reported as such,
// never worked around.
//
// ## Which tab
//
//   1. A tab already showing the video (the person is watching it, or saved
//      it from there): its page is read. Possible with the YouTube access the
//      person allowed, or with the activeTab grant a toolbar click gives.
//   2. Otherwise, with the person's permission for www.youtube.com (asked
//      once, in permissions/grant.html): a muted background tab is opened at
//      the video, read, and closed. Its visit is taken out of Chrome's history
//      unless the person had already visited that video.
//
// One video is read at a time, and a video already being read is not read
// twice. Chrome builds a background tab's page while it stays hidden, so the
// person's window never changes.
//
// ## Pages change
//
// The reader looks for the elements YouTube renders transcript lines as —
// the "In this video" panel's `transcript-segment-view-model` (2026-11) and
// the older `ytd-transcript-segment-renderer` — and answers with a reason
// rather than a guess: `no-transcript` only when YouTube's page has loaded
// and offers no transcript at all.
//
// Pure apart from what it is handed (tabs, executeScript, history), so it is
// tested without Chrome (youtube-transcript.test.js).

/** The optional host permission a background read needs. Mirrors manifest.json's optional_host_permissions. */
export const YOUTUBE_ACCESS = Object.freeze({ name: "YouTube", hosts: ["www.youtube.com"], origins: ["https://www.youtube.com/*"] });

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Bounds on one answer: a ten-hour stream is a few thousand lines. Mirrors TRANSCRIPT_LIMITS in src/lib/resources/server/transcripts.ts. */
export const YOUTUBE_TRANSCRIPT_LIMITS = Object.freeze({ segments: 20000, segmentChars: 2000, titleChars: 300, channelChars: 200 });

/** How long a background tab may take to load, and how long the page may take to show its transcript. */
export const YOUTUBE_READ_TIMING = Object.freeze({ loadMs: 30000, pageMs: 25000, pollMs: 250 });

/** Why a transcript could not be read. Hubble Desktop turns each into words (src/lib/resources/youtube-browser.ts). */
export const YOUTUBE_READ_REASONS = Object.freeze([
  "no-transcript", //      the page loaded and YouTube offers no transcript for this video
  "video-unavailable", //  YouTube shows the video as private, removed or restricted
  "no-access", //          not open in a tab Hubble may read, and no permission to open one
  "not-loaded", //         the page or its transcript didn't finish loading in time
  "read-failed", //        reading threw
  "invalid", //            not a video id
]);

export function isVideoId(value) {
  return typeof value === "string" && VIDEO_ID.test(value);
}

/** The watch address Hubble opens — always rebuilt from the id, never taken from anywhere else. */
export function watchUrlOf(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** The video a tab shows, when it is a YouTube watch page this reader can read; otherwise undefined. */
export function watchedVideoIdOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || !/^(?:www\.)?youtube\.com$/i.test(parsed.hostname) || parsed.pathname !== "/watch") return undefined;
  const id = parsed.searchParams.get("v");
  return isVideoId(id) ? id : undefined;
}

/**
 * Reads the transcript of `videoId` from the YouTube page it runs in.
 * Injected with chrome.scripting.executeScript, so it is self-contained: it
 * must not reference anything else in this module. `env` is for tests only
 * (a document, an address, a clock) — executeScript passes just the first two
 * arguments.
 *
 * Resolves to { ok: true, videoId, segments: [{ start?, text }], title?, channel?, track? }
 * or { ok: false, reason, detail? } — see YOUTUBE_READ_REASONS.
 */
export async function readYouTubeTranscriptFromPage(videoId, settings = {}, env = {}) {
  const doc = env.document ?? document;
  const href = env.href ?? location.href;
  const now = env.now ?? (() => Date.now());
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitMs = typeof settings?.waitMs === "number" && settings.waitMs > 0 ? settings.waitMs : 25000;
  const pollMs = typeof settings?.pollMs === "number" && settings.pollMs > 0 ? settings.pollMs : 250;
  const MAX_SEGMENTS = 20000;
  const MAX_TEXT = 2000;
  const PANEL = "ytd-engagement-panel-section-list-renderer";
  const EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const SEGMENT = "transcript-segment-view-model, ytd-transcript-segment-renderer";
  const TIME = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/;

  const clean = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const secondsOf = (value) => {
    const match = TIME.exec(value ?? "");
    if (!match) return undefined;
    return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  };
  const flexy = () => doc.querySelector("ytd-watch-flexy");
  /** The panels YouTube prepares for a video that has a transcript (absent when it has none). */
  const transcriptPanels = () => [...doc.querySelectorAll(PANEL)].filter((panel) => /transcript/i.test(panel.getAttribute("target-id") || ""));
  const expandedPanels = () => [...doc.querySelectorAll(PANEL)].filter((panel) => panel.getAttribute("visibility") === EXPANDED);
  /**
   * The open panel that holds transcript lines, if any. On a video with chapters it is the
   * untagged "In this video" panel (Chapters | Transcript), so any open panel with lines counts.
   */
  const openPanel = () => expandedPanels().find((panel) => panel.querySelector(SEGMENT)) ?? null;
  /** An open "In this video" panel showing its Chapters tab: choose its Transcript tab. */
  const chooseTranscriptTab = () => {
    for (const panel of expandedPanels()) {
      const tab = panel.querySelector('button[aria-label="Transcript"][aria-selected="false"]');
      if (tab) {
        tab.click();
        return;
      }
    }
  };
  const showButton = () => {
    const buttons = [...doc.querySelectorAll("ytd-video-description-transcript-section-renderer button")];
    return buttons.find((button) => button.offsetParent !== null) ?? buttons[0] ?? null;
  };
  /** YouTube's own "Video unavailable" (private, removed, restricted) for this page. */
  const unavailable = () => {
    const page = flexy();
    if (!page?.hasAttribute("player-unavailable")) return false;
    const error = doc.querySelector("yt-playability-error-supported-renderers");
    return Boolean(error && !error.hidden && error.textContent.trim());
  };
  const loaded = () => {
    const page = flexy();
    return Boolean(page && page.getAttribute("video-id") === videoId && page.hasAttribute("has-metadata"));
  };
  const lineOf = (segment) => {
    const stamp =
      segment.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp") ??
      [...segment.querySelectorAll("div, span")].find((element) => element.children.length === 0 && TIME.test(element.textContent ?? ""));
    const words = segment.querySelector('[role="text"], .segment-text, yt-formatted-string.segment-text');
    const text = clean(words?.textContent, MAX_TEXT);
    if (!text) return undefined;
    const start = secondsOf(stamp?.textContent);
    return start === undefined ? { text } : { start, text };
  };

  try {
    let address;
    try {
      address = new URL(href);
    } catch {
      return { ok: false, reason: "wrong-page" };
    }
    if (!/^(?:www\.)?youtube\.com$/i.test(address.hostname) || address.pathname !== "/watch" || address.searchParams.get("v") !== videoId) {
      return { ok: false, reason: "wrong-page" };
    }
    const deadline = now() + waitMs;

    // 1. This video's page, loaded — or YouTube saying it won't show it.
    while (!loaded()) {
      if (unavailable()) return { ok: false, reason: "video-unavailable" };
      if (now() >= deadline) return { ok: false, reason: "not-loaded" };
      await sleep(pollMs);
    }
    if (settings?.pause === true) doc.querySelector("video")?.pause?.();

    // 2. Its transcript panel: already open, or opened with YouTube's own button.
    let panel = openPanel();
    let opened = false;
    if (!panel) {
      // The description's transcript section comes with the metadata; allow it a moment to render.
      const settle = Math.min(deadline, now() + 3000);
      let button = showButton();
      while (!button && now() < settle) {
        await sleep(pollMs);
        button = showButton();
      }
      if (!button) return transcriptPanels().length === 0 ? { ok: false, reason: "no-transcript" } : { ok: false, reason: "not-loaded" };
      const openBefore = new Set(expandedPanels());
      button.click();
      opened = true;
      while (!(panel = openPanel())) {
        if (now() >= deadline) {
          // Leave nothing open that wasn't: the panel may have opened empty.
          for (const left of expandedPanels()) if (!openBefore.has(left)) left.querySelector(`[id="visibility-button"] button`)?.click?.();
          return { ok: false, reason: "not-loaded" };
        }
        chooseTranscriptTab();
        await sleep(pollMs);
      }
    }

    // 3. Every line, once the panel stops adding them.
    let count = -1;
    for (;;) {
      const next = panel.querySelectorAll(SEGMENT).length;
      if (next === count || now() >= deadline) break;
      count = next;
      await sleep(pollMs * 2);
    }
    const segments = [];
    for (const segment of panel.querySelectorAll(SEGMENT)) {
      const line = lineOf(segment);
      if (line) segments.push(line);
      if (segments.length >= MAX_SEGMENTS) break;
    }
    const track = clean(panel.querySelector("ytd-transcript-footer-renderer #label-text, ytd-transcript-footer-renderer yt-dropdown-menu")?.textContent, 80);

    // 4. Leave the page as it was.
    if (opened) panel.querySelector('[id="visibility-button"] button, button[aria-label="Close transcript"]')?.click?.();

    if (segments.length === 0) return { ok: false, reason: "no-transcript" };
    const title = clean(doc.querySelector("ytd-watch-metadata h1")?.textContent, 300);
    // The channel's link: the element around it repeats the name for its tooltip.
    const channel = clean((doc.querySelector("ytd-watch-metadata ytd-channel-name a") ?? doc.querySelector("ytd-watch-metadata ytd-channel-name #text"))?.textContent, 200);
    return { ok: true, videoId, segments, ...(title ? { title } : {}), ...(channel ? { channel } : {}), ...(track ? { track } : {}) };
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: String(error?.message ?? error).slice(0, 200) };
  }
}

const KNOWN_REASONS = new Set([...YOUTUBE_READ_REASONS, "wrong-page"]);
const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * What a page answered, re-checked before it goes anywhere: an answer for
 * another video, an unknown reason or a malformed line is not passed on.
 */
export function readTranscriptAnswer(value, videoId) {
  if (!value || typeof value !== "object") return { ok: false, reason: "read-failed" };
  if (value.ok !== true) {
    const reason = KNOWN_REASONS.has(value.reason) ? value.reason : "read-failed";
    return { ok: false, reason, ...(typeof value.detail === "string" && value.detail ? { detail: value.detail.slice(0, 200) } : {}) };
  }
  if (value.videoId !== videoId || !Array.isArray(value.segments)) return { ok: false, reason: "read-failed" };
  const segments = [];
  for (const raw of value.segments.slice(0, YOUTUBE_TRANSCRIPT_LIMITS.segments)) {
    const words = text(raw?.text, YOUTUBE_TRANSCRIPT_LIMITS.segmentChars);
    if (!words) continue;
    const start = typeof raw.start === "number" && Number.isFinite(raw.start) && raw.start >= 0 && raw.start <= 48 * 3600 ? raw.start : undefined;
    segments.push(start === undefined ? { text: words } : { start, text: words });
  }
  if (segments.length === 0) return { ok: false, reason: "no-transcript" };
  const title = text(value.title, YOUTUBE_TRANSCRIPT_LIMITS.titleChars);
  const channel = text(value.channel, YOUTUBE_TRANSCRIPT_LIMITS.channelChars);
  const track = text(value.track, 80);
  return { ok: true, videoId, segments, ...(title ? { title } : {}), ...(channel ? { channel } : {}), ...(track ? { track } : {}) };
}

/** executeScript's refusal for a page the extension has no access to (Chrome words it a few ways). */
export function isAccessError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /cannot access|permission|host permission|must request permission/i.test(message);
}

/**
 * @param deps.tabs        { query(q), create(props), update(id, props), remove(id), get(id) }
 * @param deps.inject      (tabId, videoId, settings) => Promise<page answer>   executeScript(readYouTubeTranscriptFromPage)
 * @param deps.hasAccess   () => Promise<boolean>   the www.youtube.com permission
 * @param deps.history     { getVisits({ url }), deleteUrl({ url }) } — optional
 * @param deps.sleep, deps.now, deps.log
 */
export function createYouTubeTranscriptReader(deps) {
  const { tabs, inject, hasAccess, history, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = () => {}, timing = YOUTUBE_READ_TIMING } = deps;
  const inFlight = new Map();
  let queue = Promise.resolve();

  async function readIn(tabId, videoId, settings) {
    return readTranscriptAnswer(await inject(tabId, videoId, { waitMs: timing.pageMs, pollMs: timing.pollMs, ...settings }), videoId);
  }

  async function waitForLoad(tabId) {
    const deadline = now() + timing.loadMs;
    for (;;) {
      const tab = await tabs.get(tabId).catch(() => undefined);
      if (!tab) return false;
      if (tab.status === "complete") return true;
      if (now() >= deadline) return false;
      await sleep(timing.pollMs);
    }
  }

  /** Visits of `url` made since `since`, and none before: Hubble's own, taken back out of history. */
  async function forgetOwnVisit(url, since) {
    if (!history || !url) return;
    try {
      const visits = await history.getVisits({ url });
      if (visits.length > 0 && visits.every((visit) => typeof visit.visitTime === "number" && visit.visitTime >= since - 1000)) await history.deleteUrl({ url });
    } catch {
      // History is a nicety; the transcript is what was asked for.
    }
  }

  async function readInBackgroundTab(videoId) {
    const url = watchUrlOf(videoId);
    const startedAt = now();
    let tabId;
    let finalUrl;
    try {
      const created = await tabs.create({ url, active: false });
      tabId = created?.id;
      if (!Number.isInteger(tabId)) return { ok: false, reason: "read-failed" };
      await tabs.update(tabId, { muted: true }).catch(() => {});
      if (!(await waitForLoad(tabId))) return { ok: false, reason: "not-loaded" };
      const answer = await readIn(tabId, videoId, { pause: true });
      finalUrl = (await tabs.get(tabId).catch(() => undefined))?.url;
      return answer;
    } catch (error) {
      log("youtube-read-failed", { where: "background-tab", detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: isAccessError(error) ? "no-access" : "read-failed" };
    } finally {
      if (Number.isInteger(tabId)) await tabs.remove(tabId).catch(() => {});
      await forgetOwnVisit(url, startedAt);
      if (finalUrl && finalUrl !== url) await forgetOwnVisit(finalUrl, startedAt);
    }
  }

  async function readOnce(videoId) {
    let open = [];
    try {
      open = await tabs.query({});
    } catch {
      open = [];
    }
    // The person's own tabs first — the one in front of them before others. Never a private window's.
    const showing = open
      .filter((tab) => Number.isInteger(tab.id) && !tab.incognito && watchedVideoIdOf(tab.url ?? "") === videoId)
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    for (const tab of showing) {
      try {
        const answer = await readIn(tab.id, videoId, {});
        if (answer.ok || answer.reason !== "wrong-page") return { ...answer, via: "open-tab" };
      } catch (error) {
        if (!isAccessError(error)) log("youtube-read-failed", { where: "open-tab", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!(await hasAccess().catch(() => false))) return { ok: false, reason: "no-access" };
    const answer = await readInBackgroundTab(videoId);
    return answer.ok ? { ...answer, via: "background-tab" } : answer;
  }

  return {
    /** One video's transcript. Never throws. */
    read(videoId) {
      if (!isVideoId(videoId)) return Promise.resolve({ ok: false, reason: "invalid" });
      const running = inFlight.get(videoId);
      if (running) return running;
      const run = queue
        .then(() => readOnce(videoId))
        .catch((error) => {
          log("youtube-read-failed", { where: "reader", detail: error instanceof Error ? error.message : String(error) });
          return { ok: false, reason: "read-failed" };
        })
        .then((answer) => {
          // "wrong-page" is this module's own business: outside it, the page didn't show the video in time.
          if (!answer.ok && answer.reason === "wrong-page") return { ok: false, reason: "not-loaded" };
          return answer;
        })
        .finally(() => inFlight.delete(videoId));
      queue = run.then(
        () => undefined,
        () => undefined
      );
      inFlight.set(videoId, run);
      return run;
    },
  };
}

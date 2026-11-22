import { isBrowserConnected, sendBrowserCommand } from "@/lib/browser/bridge";
import { DESKTOP_UNREACHABLE } from "@/lib/browser/protocol";
import { normalizeTranscript } from "./transcript";
import type { TranscriptSegment } from "./types";

/**
 * A YouTube video's transcript, from YouTube's own page in the person's
 * Chrome (Hubble for Chrome, extension/src/youtube-transcript.js).
 *
 * YouTube shows a transcript under every video with captions ("Show
 * transcript"). Hubble has no way to fetch those lines itself without
 * getting past YouTube's bot checks or calling its private API — neither of
 * which it does — and it doesn't pay a service to. So it asks Hubble for
 * Chrome to read them off the page, the way a person would copy them: in a
 * tab already showing the video, or in a muted background tab it opens for
 * that once the person has allowed it to read youtube.com.
 *
 * Only the 11-character video id is sent. Every answer is re-read here: the
 * lines go through the same cleaning as any other transcript, and anything
 * that isn't a known outcome is a failure, never an empty transcript.
 */

export type BrowserTranscriptFailure =
  /** The page loaded and YouTube offers no transcript for this video. */
  | "no_transcript"
  /** YouTube shows the video as private, removed or restricted. */
  | "video_unavailable"
  /** Chrome hasn't allowed Hubble for Chrome to read youtube.com, and the video isn't open where it may read it. */
  | "no_access"
  /** No Hubble for Chrome is connected to this Hubble. */
  | "no_extension"
  /** One is connected but didn't answer: Chrome is closed, or the extension asleep and not woken. */
  | "no_answer"
  /** A Hubble for Chrome from before transcripts. */
  | "outdated"
  /** The page, or its transcript, didn't load in time. */
  | "not_loaded"
  | "timeout"
  | "failed";

export type BrowserTranscript =
  | { ok: true; segments: TranscriptSegment[]; title?: string; channel?: string }
  | { ok: false; reason: BrowserTranscriptFailure };

export type BrowserTranscriptRequest = {
  videoId: string;
  /**
   * The person just did something (saved the video, pressed Try again):
   * Hubble Desktop may wake Chrome's extension to answer. A read Hubble
   * starts by itself (after a restart) is answered only if it's awake.
   */
  wake: boolean;
};

/** A background tab's load, the page's transcript, and a queue of earlier videos ahead of this one. */
export const BROWSER_TRANSCRIPT_TIMEOUT_MS = 90_000;
/** Read by itself, with nothing woken: an awake extension collects within a second and a read takes a few. */
export const BROWSER_TRANSCRIPT_BACKGROUND_TIMEOUT_MS = 30_000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** The page's reasons Hubble acts on; anything else (another reason, a prototype name) is a failure. */
const PAGE_REASONS = new Map<unknown, BrowserTranscriptFailure>([
  ["no-transcript", "no_transcript"],
  ["video-unavailable", "video_unavailable"],
  ["no-access", "no_access"],
  ["not-loaded", "not_loaded"],
]);

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

/** What the extension answered, re-read. Exported for tests. */
export function readBrowserTranscript(result: unknown): BrowserTranscript {
  if (!result || typeof result !== "object") return { ok: false, reason: "failed" };
  const answer = result as { ok?: unknown; reason?: unknown; segments?: unknown; title?: unknown; channel?: unknown };
  if (answer.ok !== true) return { ok: false, reason: PAGE_REASONS.get(answer.reason) ?? "failed" };
  if (!Array.isArray(answer.segments)) return { ok: false, reason: "failed" };
  const segments = normalizeTranscript(answer.segments as { start?: unknown; text?: unknown }[]);
  if (segments.length === 0) return { ok: false, reason: "no_transcript" };
  const title = text(answer.title, 300);
  const channel = text(answer.channel, 200);
  return { ok: true, segments, ...(title ? { title } : {}), ...(channel ? { channel } : {}) };
}

/** Why the command itself didn't come back with an answer. */
function commandFailure(error: string): BrowserTranscriptFailure {
  if (error === DESKTOP_UNREACHABLE) return isBrowserConnected() ? "no_answer" : "no_extension";
  if (/unknown or disallowed browser action|doesn't ask chrome that|no handler registered/i.test(error)) return "outdated";
  if (/timed out|timed-out/i.test(error)) return "timeout";
  return "failed";
}

/** Asks Hubble for Chrome for one video's transcript. Never throws. */
export async function readTranscriptThroughBrowser({ videoId, wake }: BrowserTranscriptRequest): Promise<BrowserTranscript> {
  if (!VIDEO_ID.test(videoId)) return { ok: false, reason: "failed" };
  const answer = await sendBrowserCommand<{ videoId: string }, unknown>(
    "read_youtube_transcript",
    { videoId },
    wake ? { timeoutMs: BROWSER_TRANSCRIPT_TIMEOUT_MS } : { background: true, timeoutMs: BROWSER_TRANSCRIPT_BACKGROUND_TIMEOUT_MS }
  );
  return answer.ok ? readBrowserTranscript(answer.result) : { ok: false, reason: commandFailure(answer.error) };
}

export type YouTubeAccessAnswer = { granted: boolean } | { granted: false; reason: BrowserTranscriptFailure };

/**
 * Opens Hubble for Chrome's own window asking the person to let it read
 * youtube.com (Chrome's permission prompt comes from a click there). Waits
 * for their answer.
 */
export async function requestYouTubeAccess(): Promise<YouTubeAccessAnswer> {
  const answer = await sendBrowserCommand<Record<string, never>, { granted?: unknown }>("request_youtube_access", {}, { timeoutMs: 120_000 });
  if (!answer.ok) return { granted: false, reason: commandFailure(answer.error) };
  return { granted: answer.result?.granted === true };
}

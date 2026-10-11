import type { TranscriptSegment } from "./types";

/**
 * Video transcripts: reading one a person supplied, cleaning one a reader
 * service returned, and formatting its times.
 *
 * ## Where a transcript comes from
 *
 * Two doors, one shape (`TranscriptSegment[]`, in playback order):
 *
 *   - **Captions Hubble fetched.** When the server has a transcript provider
 *     configured (server/transcripts), the reader asks it for the video's
 *     *existing* captions — never speech recognition, never the video or
 *     audio. YouTube's own captions API only serves a video's owner, and
 *     Hubble does not scrape watch pages or get around YouTube's bot
 *     checks itself; without a provider, a video is saved with its metadata
 *     and says that automatic transcripts are not set up.
 *   - **A transcript the person supplied** — a WebVTT or SubRip caption
 *     file, or text copied from YouTube's own "Show transcript" panel —
 *     parsed here with start times where the source had them.
 *
 * Either way Hubble never presents a transcript it did not receive.
 */

export type TranscriptLine = TranscriptSegment;

const TIMESTAMP = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

function seconds(match: RegExpMatchArray): number {
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

function stripMarkup(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\s+/g, " ").trim();
}

/** Caption cues: "00:01:02.000 --> 00:01:05.000" followed by text lines (VTT and SRT alike). */
function parseCues(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n");
    const timing = rows.findIndex((row) => row.includes("-->"));
    if (timing === -1) continue;
    const [from, to] = rows[timing]!.split("-->");
    const start = from?.match(TIMESTAMP);
    const end = to?.match(TIMESTAMP);
    const body = stripMarkup(rows.slice(timing + 1).join(" "));
    if (!body) continue;
    // Rolling captions repeat the previous line; keep each sentence once.
    if (lines[lines.length - 1]?.text === body) continue;
    lines.push({ ...(start ? { start: seconds(start) } : {}), ...(start && end && seconds(end) > seconds(start) ? { end: seconds(end) } : {}), text: body });
  }
  return lines;
}

/** YouTube's transcript panel copies as "0:12\nText\n0:15\nMore text" (or "0:12 Text" on one line). */
function parsePanel(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let pendingStart: number | undefined;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const row = raw.trim();
    if (!row) continue;
    const stamp = row.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(.*)$/);
    if (stamp) {
      const at = stamp[1]!.match(TIMESTAMP);
      pendingStart = at ? seconds(at) : undefined;
      if (stamp[2]) {
        lines.push({ ...(pendingStart !== undefined ? { start: pendingStart } : {}), text: stamp[2] });
        pendingStart = undefined;
      }
      continue;
    }
    lines.push({ ...(pendingStart !== undefined ? { start: pendingStart } : {}), text: row });
    pendingStart = undefined;
  }
  return lines;
}

export function parseTranscript(text: string): TranscriptLine[] {
  const input = text.replace(/^﻿/, "");
  if (input.includes("-->")) return parseCues(input);
  return parsePanel(input);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Caption text as plain words: markup, HTML entities (sometimes doubly encoded) and runs of whitespace removed. */
export function cleanCaptionText(raw: string): string {
  let text = raw;
  // Providers pass YouTube's escaping through, sometimes twice (&amp;#39;).
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
  }
  return stripMarkup(text);
}

const MAX_SECONDS = 48 * 3600;

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS ? Math.round(value * 1000) / 1000 : undefined;
}

/**
 * Segments made trustworthy for storage, search and display: text cleaned,
 * empty lines dropped, times bounded, playback order restored (stable, so
 * lines without times keep their place relative to each other), an `end`
 * that is not after its `start` dropped, and a line that only repeats the
 * one before it (rolling captions) kept once.
 */
export function normalizeTranscript(input: readonly { start?: unknown; end?: unknown; text?: unknown }[]): TranscriptSegment[] {
  const cleaned: TranscriptSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw.text !== "string") continue;
    const text = cleanCaptionText(raw.text);
    if (!text) continue;
    const start = time(raw.start);
    const end = time(raw.end);
    cleaned.push({ ...(start !== undefined ? { start } : {}), ...(start !== undefined && end !== undefined && end > start ? { end } : {}), text });
  }
  const timed = cleaned.every((line) => line.start !== undefined);
  const ordered = timed ? cleaned.map((line, index) => ({ line, index })).sort((a, b) => a.line.start! - b.line.start! || a.index - b.index).map((entry) => entry.line) : cleaned;
  const out: TranscriptSegment[] = [];
  for (const line of ordered) {
    const previous = out[out.length - 1];
    if (previous && previous.text === line.text && (line.start === undefined || previous.start === undefined || line.start - previous.start < 10)) {
      if (line.end !== undefined && (previous.end === undefined || line.end > previous.end)) previous.end = line.end;
      continue;
    }
    out.push(line);
  }
  return out;
}

/** A BCP 47-shaped language tag ("en", "pt-BR", "zh-Hant"), or nothing. */
export function cleanLanguageTag(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(value.trim()) ? value.trim() : undefined;
}

/** The last time a transcript reaches — how long the spoken part runs, not necessarily the video. */
export function transcriptSpan(lines: readonly TranscriptSegment[]): number {
  let span = 0;
  for (const line of lines) span = Math.max(span, line.end ?? line.start ?? 0);
  return span;
}

/**
 * "8:42", or "1:08:42" past the hour. Pass `span` (a transcript's length) to
 * keep a list in one format: in a long lecture, 8:42 reads "0:08:42".
 */
export function formatTimestamp(total: number, span?: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const long = h > 0 || (span !== undefined && span >= 3600);
  const mm = long ? String(m).padStart(2, "0") : String(m);
  return `${long ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

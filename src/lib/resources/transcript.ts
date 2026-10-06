/**
 * A video transcript the person supplied — a WebVTT or SubRip caption file,
 * or text copied from YouTube's own "Show transcript" panel — as lines with
 * start times where the source had them.
 *
 * Hubble does not download YouTube captions itself: YouTube's terms forbid
 * automated access outside its published APIs, and its captions API only
 * serves a video's owner. So a transcript reaches a project the same way a
 * PDF that could not be fetched does — the person brings it — and Hubble
 * never presents a transcript it did not receive.
 */

export type TranscriptLine = { start?: number; text: string };

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
    const start = rows[timing]!.match(TIMESTAMP);
    const body = stripMarkup(rows.slice(timing + 1).join(" "));
    if (!body) continue;
    // Rolling captions repeat the previous line; keep each sentence once.
    if (lines[lines.length - 1]?.text === body) continue;
    lines.push({ ...(start ? { start: seconds(start) } : {}), text: body });
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

export function formatTimestamp(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

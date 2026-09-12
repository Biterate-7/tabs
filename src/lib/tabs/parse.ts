import type { ParseResult, Tab } from "./types";
import { normalizeUrl } from "./normalize";
import { isSafeOpenUrl } from "@/lib/browser/protocol";

export function splitInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function ensureProtocol(token: string): string {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(token) ? token : `https://${token}`;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `tab-${Date.now()}-${counter}`;
}

function toTab(candidateUrl: string, parsed: URL): Tab {
  return {
    id: nextId(),
    url: candidateUrl,
    normalizedUrl: normalizeUrl(parsed),
    domain: parsed.hostname.replace(/^www\./, ""),
  };
}

/**
 * Parses a single URL-shaped token into a `Tab`, or `null` if it isn't one.
 * Shared by `parseUrls` (splitting a pasted text blob) and by the browser
 * extension import path (already-structured URLs) so both go through the
 * exact same validation/normalization instead of duplicating it.
 *
 * Only http(s) becomes a `Tab`. A Tab is a saved web page the user expects
 * to re-open, and every opening path already refuses anything else — the web
 * app in openTab, the desktop app in Rust (`open_external`), the extension in
 * browser-commands.js. So a non-http(s) Tab could never be opened anywhere;
 * accepting one would only mean storing an un-openable row, and in the
 * `javascript:` case keeping a payload in local storage. Note that a
 * structural check alone is not enough here:
 * `javascript://example.com/%0aalert(1)` parses cleanly and has a dotted
 * hostname.
 *
 * The rule comes from `isSafeOpenUrl` rather than being restated, so the
 * parser, the opener and the extension cannot drift apart. It re-parses the
 * URL, which is deliberate — one shared definition is worth more than the
 * saved microseconds (the 250-URL budget in the tests still passes). Its
 * length ceiling applies here too, so a pathological multi-kilobyte URL is
 * rejected at input instead of becoming a tab nothing can open.
 */
export function parseSingleUrl(token: string): Tab | null {
  const candidate = ensureProtocol(token.trim());
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!parsed.hostname.includes(".")) return null;
  if (!isSafeOpenUrl(candidate)) return null;
  return toTab(candidate, parsed);
}

export function parseUrls(raw: string): ParseResult {
  const tokens = splitInput(raw);
  const tabs: Tab[] = [];
  let invalidCount = 0;

  for (const token of tokens) {
    const tab = parseSingleUrl(token);
    if (!tab) {
      invalidCount += 1;
      continue;
    }
    tabs.push(tab);
  }

  return { tabs, invalidCount };
}

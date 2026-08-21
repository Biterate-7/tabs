import type { ParseResult, Tab } from "./types";
import { normalizeUrl } from "./normalize";

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

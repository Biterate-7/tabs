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

export function parseUrls(raw: string): ParseResult {
  const tokens = splitInput(raw);
  const tabs: Tab[] = [];
  let invalidCount = 0;

  for (const token of tokens) {
    const candidate = ensureProtocol(token);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      invalidCount += 1;
      continue;
    }
    if (!parsed.hostname.includes(".")) {
      invalidCount += 1;
      continue;
    }
    tabs.push(toTab(candidate, parsed));
  }

  return { tabs, invalidCount };
}

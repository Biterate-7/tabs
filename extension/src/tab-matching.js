// Pure logic only — no `chrome.*` calls in this file (same discipline as
// tabs.js / browser-commands.js), so matching can be unit tested without
// mocking browser APIs. background.js / browser-actions.js own the actual
// chrome.tabs.query()/update() calls and hand raw tabs to findMatchingTab().
//
// The extension has no bundler (see extension/README.md), so
// normalizeUrlForMatch mirrors src/lib/tabs/normalize.ts's normalizeUrl
// exactly rather than importing it — the same "duplicated on purpose"
// tradeoff already made between src/config.js and content-script.js.

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
];

/**
 * Returns a normalized comparison key for a URL, or null if it isn't
 * parseable at all — an unparseable URL never matches anything rather than
 * throwing out of findMatchingTab.
 */
export function normalizeUrlForMatch(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  for (const param of TRACKING_PARAMS) {
    parsed.searchParams.delete(param);
  }
  parsed.searchParams.sort();

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const search = parsed.searchParams.toString();

  return `${parsed.protocol}//${parsed.hostname}${pathname}${search ? `?${search}` : ""}`;
}

/**
 * Finds the best already-open tab matching `targetUrl` among `tabs` (raw
 * chrome.tabs.Tab objects), or undefined if none match. Two URLs match when
 * they normalize to the same key (see normalizeUrlForMatch) — this is
 * deliberately looser than exact string equality (a trailing slash or a
 * tracking param shouldn't cause a duplicate tab) but no looser, so genuinely
 * different pages never collide.
 *
 * When more than one open tab matches, the currently active tab (in
 * whichever window it's in) wins over background ones — activating a tab the
 * user is already looking at is a no-op the user will barely notice, which is
 * the least surprising outcome. Otherwise the first match wins, a stable and
 * deterministic choice rather than an arbitrary one.
 */
export function findMatchingTab(tabs, targetUrl) {
  const targetKey = normalizeUrlForMatch(targetUrl);
  if (targetKey === null) return undefined;

  const matches = (tabs ?? []).filter((tab) => tab?.url && normalizeUrlForMatch(tab.url) === targetKey);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  return matches.find((tab) => tab.active) ?? matches[0];
}

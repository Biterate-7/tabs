/**
 * Deterministic keyword extraction/naming for Auto-Organize (AGENTS.md
 * section 15: "keep it deterministic" — no Gemini call is needed to decide
 * a cluster's name or which tabs belong together by topic). Deliberately
 * dependency-free, same spirit as src/lib/search/rank.ts's hand-rolled
 * scoring.
 */

import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "./domain-identity";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "what", "why", "who", "when", "where",
  "is", "are", "was", "were", "be", "been", "being", "of", "in", "on", "to",
  "a", "an", "at", "by", "from", "into", "your", "you", "this", "that",
  "these", "those", "it", "its", "as", "or", "but", "not", "no", "yes",
  "home", "index", "page", "pages", "search", "results", "new", "tab",
  "untitled", "welcome", "about", "www", "http", "https", "html", "htm",
  "com", "org", "net", "io", "co", "edu", "gov", "dev", "app", "ai", "us",
  "get", "getting", "started", "docs", "documentation", "learn", "guide",
  // Generic hub/search words only — a shared "Google Search" title tells you
  // nothing about topic. Deliberately NOT extended to youtube/gmail/chatgpt/
  // amazon/outlook/etc: those ARE the destination/product (see
  // domain-identity.ts's BRAND_NAMES), so stripping them as stopwords would
  // erase the one word that actually names that cluster.
  "google", "bing", "duckduckgo",
]);

/** Known dev-tool hosts get a synthetic "development" token boost — the one small domain-specific special-case, since generic keyword frequency alone under-names these clusters (AGENTS.md's "Development" example). */
const DEV_TOOL_DOMAINS = new Set([
  "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
  "npmjs.com", "developer.mozilla.org", "stackexchange.com",
]);

function isMostlyNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !isMostlyNumeric(t));
}

/** Strips a trailing TLD-like segment (real gTLDs plus RFC 2606's reserved "example", common in tests/docs) so it never leaks into a topic token. */
export function domainTokens(domain: string): string[] {
  const withoutTld = domain.replace(/\.(com|org|net|io|co|edu|gov|dev|app|ai|example)$/i, "");
  return tokenize(withoutTld.replace(/\./g, " "));
}

/** All significant tokens for one tab — title first (richer signal), then domain. */
export function tabTokens(tab: { title?: string; domain: string }): string[] {
  const fromTitle = tokenize(tab.title?.trim() || "");
  const fromDomain = domainTokens(tab.domain);
  const boosted = DEV_TOOL_DOMAINS.has(tab.domain.toLowerCase()) ? ["development"] : [];
  return [...new Set([...fromTitle, ...fromDomain, ...boosted])];
}

/** Best-cased display form for a token — preserves a short all-caps acronym exactly as first seen (e.g. "MUN"), Title-Cases everything else. */
function caseToken(original: string): string {
  if (original.length <= 4 && original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return original;
  }
  return original[0].toUpperCase() + original.slice(1).toLowerCase();
}

/**
 * Picks a deterministic display name for a cluster of tabs, from token
 * frequency across the cluster (each tab contributes its unique token set
 * once, so one verbose title can't dominate). Ties broken by first-seen
 * order for reproducibility. Combines the top two tokens only when they
 * strongly co-occur (e.g. "College" + "Research"); otherwise uses just the
 * single most frequent one.
 */
export function deriveClusterName(tabs: { title?: string; domain: string }[]): string {
  const freq = new Map<string, number>();
  const firstSeenIndex = new Map<string, number>();
  const firstSeenCasing = new Map<string, string>();
  const cooccurWithTop = new Map<string, number>();
  let order = 0;

  const perTabTokens: string[][] = [];
  for (const tab of tabs) {
    const rawTitle = tab.title?.trim() || "";
    const rawTokensWithCasing = rawTitle.split(/[^a-zA-Z0-9]+/).filter((t) => t.length >= 3);
    for (const raw of rawTokensWithCasing) {
      const lower = raw.toLowerCase();
      if (!firstSeenCasing.has(lower)) firstSeenCasing.set(lower, raw);
    }

    const tokens = tabTokens(tab);
    perTabTokens.push(tokens);
    for (const tok of tokens) {
      if (!firstSeenIndex.has(tok)) firstSeenIndex.set(tok, order++);
      if (!firstSeenCasing.has(tok)) firstSeenCasing.set(tok, tok);
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }

  if (freq.size === 0) return "Miscellaneous";

  const sorted = [...freq.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (firstSeenIndex.get(a[0]) ?? 0) - (firstSeenIndex.get(b[0]) ?? 0);
  });

  const [topToken, topCount] = sorted[0];

  for (const tokens of perTabTokens) {
    if (tokens.includes(topToken)) {
      for (const tok of tokens) {
        if (tok !== topToken) cooccurWithTop.set(tok, (cooccurWithTop.get(tok) ?? 0) + 1);
      }
    }
  }

  const runnerUp = sorted.slice(1).find(([tok, count]) => {
    const cooccur = cooccurWithTop.get(tok) ?? 0;
    return count >= 2 && cooccur >= Math.ceil(topCount * 0.5);
  });

  const topDisplay = caseToken(firstSeenCasing.get(topToken) ?? topToken);
  if (!runnerUp) return topDisplay;

  const runnerUpDisplay = caseToken(firstSeenCasing.get(runnerUp[0]) ?? runnerUp[0]);
  return `${topDisplay} ${runnerUpDisplay}`;
}

/** A dominant site needs at least this many members AND this share of the group before its brand name wins over a title-derived topic name — see deriveSectionName. */
const DOMAIN_NAME_MIN_MEMBERS = 2;
const DOMAIN_NAME_MIN_SHARE = 0.5;

/**
 * The single naming entry point every "name this group of tabs" call site
 * should use (AGENTS.md §4: deterministic section naming for strong
 * website/domain clusters, never left to the AI to invent). Prefers a known
 * brand/product name when a majority of the group shares one non-generic
 * site identity — e.g. 14 Instagram tabs always become "Instagram", never
 * whatever title token happens to be most frequent — and otherwise falls
 * back to deriveClusterName's topic/keyword-frequency naming.
 */
export function deriveSectionName(tabs: { title?: string; domain: string }[]): string {
  if (tabs.length === 0) return "Miscellaneous";

  const counts = new Map<string, number>();
  for (const t of tabs) {
    const identity = canonicalSiteIdentity(t.domain);
    if (isGenericSiteIdentity(identity)) continue;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= DOMAIN_NAME_MIN_MEMBERS && dominant[1] / tabs.length >= DOMAIN_NAME_MIN_SHARE) {
    return getDomainSectionName(dominant[0]);
  }
  return deriveClusterName(tabs);
}

/** Jaccard-style overlap in [0, 1] between two token sets — used to score cluster↔existing-workspace fit. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const tok of setA) if (setB.has(tok)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

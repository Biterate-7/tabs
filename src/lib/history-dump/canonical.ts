import { TRACKING_PARAMS } from "@/lib/tabs/normalize";
import { canonicalSiteIdentity, getDomainSectionName } from "@/lib/organize/domain-identity";
import { tokenize, tokenOverlap } from "@/lib/organize/keywords";

/**
 * Canonical identity for History Dump — the deterministic "which page is
 * this, really?" layer that runs BEFORE scoring, semantic grouping and graph
 * generation (see aggregate.ts, its only caller).
 *
 * Deliberately layered rather than one similarity threshold:
 *
 *  - HIGH confidence:   two entries whose `key` matches are the same page,
 *                       full stop (protocol / `www.` / trailing-slash /
 *                       tracking-param variants of one URL). Merged outright.
 *  - MEDIUM confidence: same site, same meaningful context path, same
 *                       significant query, AND equivalent titles. Folds
 *                       `outlook…/mail/0/` together with
 *                       `outlook…/mail/0/inbox/id/AAMkAD…`, never `…/mail`
 *                       with `…/calendar`.
 *  - LOW:               sharing only a domain is NOT a duplicate. There is no
 *                       code path here that merges on domain alone.
 *
 * Builds on the app's existing URL/keyword utilities rather than inventing a
 * second parallel notion of normalization: `TRACKING_PARAMS` (lib/tabs/
 * normalize), `canonicalSiteIdentity`/`getDomainSectionName` (lib/organize/
 * domain-identity) and `tokenize`/`tokenOverlap` (lib/organize/keywords).
 */

/**
 * Analytics/session/share parameters beyond the strict `TRACKING_PARAMS` set
 * that lib/tabs/normalize applies app-wide. Kept local to History Dump on
 * purpose: `normalizeUrl`'s output is persisted on every Tab and compared
 * against saved workspaces, so widening it there would silently change
 * identity for already-saved tabs. Canonical keys here are scan-local and
 * never persisted, so they can afford to be more thorough.
 */
const EXTRA_NON_SEMANTIC_PARAMS = [
  "gclsrc", "dclid", "msclkid", "twclid", "yclid", "wbraid", "gbraid", "ttclid",
  "igshid", "igsh", "mc_cid", "mc_eid", "mkt_tok", "trk", "trkinfo",
  "ref", "ref_src", "referrer", "referer", "source", "src",
  "si", "feature", "spm", "scm", "cmpid", "campaign_id",
  "ei", "ved", "usg", "sca_esv", "gs_lcp", "sourceid",
  "sessionid", "session_id", "sid", "phpsessid", "jsessionid", "aspsessionid",
];

const NON_SEMANTIC_PARAMS = new Set<string>([...TRACKING_PARAMS, ...EXTRA_NON_SEMANTIC_PARAMS]);

/** Whole families of generated params — `utm_*`, HubSpot's `_hs*`, Matomo's `pk_`/`mtm_`, Oracle's `oly_`. */
const NON_SEMANTIC_PARAM_PREFIXES = ["utm_", "_hs", "hs_", "pk_", "mtm_", "piwik_", "oly_", "vero_", "_ga", "_gl"];

function isNonSemanticParam(name: string): boolean {
  const key = name.toLowerCase();
  if (NON_SEMANTIC_PARAMS.has(key)) return true;
  return NON_SEMANTIC_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** A directory-index filename carries no identity of its own — `/docs/` and `/docs/index.html` are one page. */
const INDEX_FILE_PATTERN = /^(index|default)\.(html?|php|aspx?|jsp)$/i;

/** A context path never grows past this many segments — anything deeper is item-specific, not context. */
const MAX_CONTEXT_SEGMENTS = 4;

/** Two titles are "highly similar" at or above this token overlap — see areTitlesEquivalent. */
const TITLE_SIMILARITY_THRESHOLD = 0.6;

export type CanonicalIdentity = {
  /**
   * The high-confidence identity: site + full canonical path + significant
   * query. Two entries sharing this ARE the same page — protocol, `www.`/`m.`
   * prefixes, trailing slashes, index filenames, fragments and tracking
   * params are all already gone.
   */
  key: string;
  /** `canonicalSiteIdentity(hostname)` — `www.instagram.com` and `m.instagram.com` both become `instagram.com`. */
  siteIdentity: string;
  /** The full canonical path, split into lowercased segments. */
  pathSegments: string[];
  /**
   * The *meaningful* leading path — segments up to (not including) the first
   * opaque identifier. `/mail/0/inbox/id/AAMkAD…` → `["mail"]`,
   * `/direct/inbox` → `["direct", "inbox"]`, `/calendar/0/view/month` →
   * `["calendar"]`. This is what keeps different contexts on one service
   * apart while letting per-item URLs under a single context fold together.
   */
  contextSegments: string[];
  /** Sorted `k=v` pairs of the query params that actually select content. */
  querySignature: string;
  /** The same params, addressable by name — see hasConflictingQuery. Repeated names are joined with `,`. */
  queryParams: Map<string, string>;
};

/**
 * Generic host labels that mean "the mobile/AMP rendering of", not "a
 * different product". `canonicalSiteIdentity` already strips one as a leading
 * label; stripping them wherever they appear also folds the `en.m.` style
 * (`en.m.wikipedia.org` → `en.wikipedia.org`, which it then collapses the
 * rest of the way). The registrable tail is never touched.
 */
const MOBILE_LABELS = new Set(["www", "m", "mobile", "amp", "touch"]);

function stripMobileLabels(hostname: string): string {
  const labels = hostname.trim().toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const head = labels.slice(0, -2).filter((label) => !MOBILE_LABELS.has(label));
  return [...head, ...labels.slice(-2)].join(".");
}

/**
 * True for a path segment that identifies one *item* rather than naming a
 * context: numeric ids, hashes, UUIDs and opaque base64-ish tokens. Word
 * slugs (`why-is-the-sky-blue`, `quantum_mechanics`, `random-old-page`) are
 * never opaque — they name the page, so they stay part of its context.
 */
export function looksLikeOpaqueId(segment: string): boolean {
  if (!segment) return false;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;

  if (segment.length >= 11 && /^[A-Za-z0-9_-]+$/.test(segment) && /[A-Za-z]/.test(segment)) {
    const digitCount = (segment.match(/\d/g) ?? []).length;
    const hasSeparatedWords = /[a-z]{3,}[-_][a-z]{3,}/i.test(segment);
    if (!hasSeparatedWords && digitCount >= 2) return true;
  }

  return false;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function canonicalPathSegments(pathname: string): string[] {
  const segments = pathname
    .split("/")
    .map((segment) => decodeSegment(segment).trim())
    .filter((segment) => segment.length > 0);

  if (segments.length > 0 && INDEX_FILE_PATTERN.test(segments[segments.length - 1])) {
    segments.pop();
  }

  return segments.map((segment) => segment.toLowerCase());
}

function contextSegmentsFrom(pathSegments: string[]): string[] {
  const context: string[] = [];
  for (const segment of pathSegments) {
    if (looksLikeOpaqueId(segment)) break;
    context.push(segment);
    if (context.length >= MAX_CONTEXT_SEGMENTS) break;
  }
  return context;
}

function queryParamsFrom(url: URL): Map<string, string> {
  const params = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (isNonSemanticParam(name)) continue;
    const key = name.toLowerCase();
    const existing = params.get(key);
    params.set(key, existing === undefined ? value : `${existing},${value}`);
  }
  return params;
}

function querySignatureFrom(params: Map<string, string>): string {
  return [...params].map(([name, value]) => `${name}=${value}`).sort().join("&");
}

/**
 * Canonicalizes one raw history URL. Returns `null` for anything that isn't a
 * parseable http(s) URL — callers have already run `isNoiseUrl`, so this is
 * defensive rather than a second filter.
 */
export function canonicalizeHistoryUrl(rawUrl: string): CanonicalIdentity | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const siteIdentity = canonicalSiteIdentity(stripMobileLabels(url.hostname));
  const pathSegments = canonicalPathSegments(url.pathname);
  const queryParams = queryParamsFrom(url);
  const querySignature = querySignatureFrom(queryParams);
  const path = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "/";

  return {
    key: `${siteIdentity}${path}${querySignature ? `?${querySignature}` : ""}`,
    siteIdentity,
    pathSegments,
    contextSegments: contextSegmentsFrom(pathSegments),
    querySignature,
    queryParams,
  };
}

export type CanonicalTitle = {
  /** Separator-flattened, lowercased title text — `"Instagram | Messages"` → `"instagram messages"`. */
  text: string;
  /** Topic tokens, with the site's own brand words removed so "Instagram" isn't what makes two Instagram pages look alike. */
  tokens: string[];
};

/** Unread/notification counters browsers put in front of a title — `"(12) Inbox"` is the same page as `"Inbox"`. */
const NOTIFICATION_PREFIX = /^\s*(?:[([]\s*\d+\+?\s*[)\]]|•)\s*/;

/** Separators sites use between a page name and their brand — flattened to spaces so `"A — B"`, `"A | B"` and `"A / B"` compare alike. */
const TITLE_SEPARATORS = /[|—–·»«/\\:•]+/g;

function brandTokens(siteIdentity: string): Set<string> {
  const fromBrand = tokenize(getDomainSectionName(siteIdentity));
  const fromHost = tokenize(siteIdentity.replace(/\./g, " "));
  return new Set([...fromBrand, ...fromHost]);
}

export function canonicalizeTitle(title: string | undefined, siteIdentity: string): CanonicalTitle {
  let raw = title?.trim() ?? "";
  let previous = "";
  while (raw !== previous) {
    previous = raw;
    raw = raw.replace(NOTIFICATION_PREFIX, "").trim();
  }

  const text = raw.replace(TITLE_SEPARATORS, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const brand = brandTokens(siteIdentity);
  const tokens = tokenize(text).filter((token) => !brand.has(token));

  return { text, tokens };
}

/**
 * "Highly similar" for the medium-confidence tier. Note what this is NOT: it
 * is never consulted on its own — a caller must already have established that
 * both entries share a site AND a context path, so this only decides whether
 * the *remaining* difference looks like one page named twice.
 *
 * A title left with no topic tokens (blank, or nothing but the site's own
 * brand — "Instagram", "Outlook") carries no distinguishing information, so it
 * can't be the thing that keeps two same-context pages apart.
 */
export function areTitlesEquivalent(a: CanonicalTitle, b: CanonicalTitle): boolean {
  if (a.text.length > 0 && a.text === b.text) return true;
  if (a.tokens.length === 0 || b.tokens.length === 0) return true;
  return tokenOverlap(a.tokens, b.tokens) >= TITLE_SIMILARITY_THRESHOLD;
}

function isPrefixOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length > longer.length) return false;
  return shorter.every((segment, index) => segment === longer[index]);
}

/**
 * True when the two URLs disagree about a query parameter they BOTH carry —
 * `watch?v=A` vs `watch?v=B` is two different videos and can never be a
 * duplicate. A parameter only one side carries is not a conflict: it is
 * usually state layered onto the same page (a `?t=42s` start time, an app's
 * own `?nlp=1` view flag), and the context-path and title checks are what
 * decide those cases. Naming which params those are would mean hardcoding one
 * site's vocabulary, which this module deliberately avoids.
 */
function hasConflictingQuery(a: CanonicalIdentity, b: CanonicalIdentity): boolean {
  for (const [name, value] of a.queryParams) {
    const other = b.queryParams.get(name);
    if (other !== undefined && other !== value) return true;
  }
  return false;
}

/**
 * Same service AND same meaningful context — the URL half of the
 * medium-confidence test. Requires:
 *
 *  - the same canonical site identity (a shared *domain* alone never gets past
 *    this function; the context checks below still have to pass),
 *  - no conflicting query parameter, so `watch?v=A` and `watch?v=B` stay two
 *    different videos rather than one "watch" context,
 *  - a non-empty context path on both sides, so a site's root page is only
 *    ever merged by exact identity — otherwise every page on a site would look
 *    like a continuation of its homepage,
 *  - one context path being a prefix of the other, which folds `/mail` into
 *    `/mail/inbox` but never `/mail` into `/calendar`.
 */
export function shareCanonicalContext(a: CanonicalIdentity, b: CanonicalIdentity): boolean {
  if (a.siteIdentity !== b.siteIdentity) return false;
  if (hasConflictingQuery(a, b)) return false;
  if (a.contextSegments.length === 0 || b.contextSegments.length === 0) return false;
  return isPrefixOf(a.contextSegments, b.contextSegments) || isPrefixOf(b.contextSegments, a.contextSegments);
}

export type DuplicateConfidence = "high" | "medium" | "none";

/** The one entry point aggregate.ts uses to ask "are these two the same logical page?". */
export function duplicateConfidence(
  a: { identity: CanonicalIdentity; title: CanonicalTitle },
  b: { identity: CanonicalIdentity; title: CanonicalTitle }
): DuplicateConfidence {
  if (a.identity.key === b.identity.key) return "high";
  if (shareCanonicalContext(a.identity, b.identity) && areTitlesEquivalent(a.title, b.title)) return "medium";
  return "none";
}

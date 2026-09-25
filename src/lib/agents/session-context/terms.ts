import { redactUrl, sanitizeText } from "@/lib/agents/context/sanitize";
import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "@/lib/organize/domain-identity";
import { domainTokens, tokenize } from "@/lib/organize/keywords";
import type { Tab } from "@/lib/tabs/types";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * The words a workspace is made of (Phase J.6).
 *
 * Every J.6 reasoning primitive — topics, related tabs, relevant collections —
 * works from the same per-tab terms, computed once per snapshot. The words
 * come from TabDump's own Auto-Organize tokenizer (`lib/organize/keywords.ts`:
 * lowercase `[a-z0-9]` tokens of three or more characters, its stopwords) and
 * a site from its site identity (`lib/organize/domain-identity.ts`), so the
 * agent and Auto-Organize agree on what a "word" and a "site" are.
 *
 * ## Only sanitized, redacted text is read
 *
 * Titles go through `sanitizeText` and addresses through `redactUrl` before a
 * single token is taken, and only an address's *path* is tokenized — never its
 * query — so no term can carry a secret query value, and matching a term can
 * never be used to probe one. A term is `[a-z0-9]+` by construction: nothing a
 * page puts in its title can reach a label or a reason as punctuation, markup
 * or a line break.
 *
 * ## Cached per snapshot
 *
 * The registry replaces a binding's snapshot object whenever a sync changes
 * anything, and never mutates one it holds. So a `WeakMap` keyed by the
 * snapshot is a cache that cannot go stale and needs no invalidation: a new
 * version is a new key, and an old one is collected with the snapshot.
 */

export type TabTerms = {
  tab: Tab;
  /** Position in the workspace's saved order; ties are always broken by it. */
  order: number;
  /**
   * Stemmed title words, unique, in the order they appear — without the
   * site's own brand ("… - Wikipedia", "arXiv: …"), which is the site, not a
   * topic. Falls back to the address path when the title has none.
   */
  terms: readonly string[];
  /** The same words as one key: two tabs with the same key say the same thing (a copy), and count once as evidence. */
  titleKey: string;
  /** Where `terms` came from. */
  termSource: "title" | "address" | "none";
  /** Stemmed words of the site's name (`physicsworld.example.com` → `physicsworld`). */
  siteTerms: readonly string[];
  /** Canonical site identity: `m.youtube.com` and `youtube.com` are one site. */
  site: string;
  /** The site as a person names it: "YouTube", "Wikipedia", "Physicsworld". */
  siteName: string;
  /** A springboard (google.com, bing.com) that says nothing about topic. */
  genericSite: boolean;
};

export type TermIndex = {
  entries: readonly TabTerms[];
  byId: ReadonlyMap<string, TabTerms>;
  /** Tabs whose `terms` contain each term, across the whole workspace. */
  documentFrequency: ReadonlyMap<string, number>;
  /** A term as it first appeared in a title, for labels: "MIT", "Admission". */
  display: ReadonlyMap<string, string>;
};

/**
 * A light, deterministic plural fold, so "admissions" finds "admission" and
 * "studies" finds "study". Deliberately not a stemmer: it never touches a word
 * that only looks plural ("physics", "status", "analysis", "class").
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is|ics|ous|as)$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Words kept per tab. A real title has a dozen significant words at most; a
 * 2 KB "title" written to be expensive does not get to make every analysis
 * of the workspace expensive.
 */
export const MAX_TERMS_PER_TAB = 24;

/** Stemmed significant words of a piece of text, unique, in order, at most `MAX_TERMS_PER_TAB`. */
export function termsOf(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set(tokenize(text).map(stem))].slice(0, MAX_TERMS_PER_TAB);
}

/** A natural-language query's words: the same tokenizer, so "college applications" → ["college", "application"]. At most 10. */
export function queryTerms(query: string): string[] {
  return termsOf(sanitizeText(query, 200)).slice(0, 10);
}

/** Capitalizes a term for display when its original casing is unknown. */
function titleCase(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

/** Short all-caps words keep their casing ("MIT", "SAT"); anything else is title-cased. */
function displayForm(raw: string): string {
  if (raw.length <= 4 && raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return raw;
  return titleCase(raw.toLowerCase());
}

function addressTerms(url: string): string[] {
  const redacted = redactUrl(url);
  if (!redacted) return [];
  // The path only. A query value may be a secret even after redaction's
  // name-based pass, and a term is something an agent can match against.
  let path: string;
  try {
    path = new URL(redacted.url).pathname;
  } catch {
    return [];
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: the raw path still has words in it.
  }
  return termsOf(path.replace(/[/_.-]+/g, " "));
}

/**
 * The site's brand word: the label before its public suffix
 * (`en.wikipedia.org` → "wikipedia", `admission.stanford.edu` → "stanford",
 * `bbc.co.uk` → "bbc"). A title repeating it is naming the site.
 */
function brandOf(site: string): string | undefined {
  const labels = site.split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  const suffix = labels.length >= 3 && labels[labels.length - 2].length <= 3 && labels[labels.length - 1].length === 2 ? 2 : 1;
  const label = labels[labels.length - 1 - suffix];
  return label ? stem(label.toLowerCase()) : undefined;
}

const cache = new WeakMap<SessionContextSnapshot, TermIndex>();

export function termIndex(snapshot: SessionContextSnapshot): TermIndex {
  const cached = cache.get(snapshot);
  if (cached) return cached;

  const display = new Map<string, string>();
  const documentFrequency = new Map<string, number>();
  const entries: TabTerms[] = snapshot.workspace.tabs.map((tab, order) => {
    const title = sanitizeText(tab.title);
    for (const raw of (title ?? "").split(/[^A-Za-z0-9]+/)) {
      if (raw.length < 3) continue;
      const key = stem(raw.toLowerCase());
      if (!display.has(key)) display.set(key, displayForm(raw));
    }
    const host = redactUrl(tab.url)?.domain ?? sanitizeText(tab.domain) ?? "";
    const site = canonicalSiteIdentity(host);
    const brand = brandOf(site);
    const titled = termsOf(title);
    const withoutBrand = titled.filter((term) => term !== brand);
    // A title that is only the site's name keeps it: it is all the title says.
    const fromTitle = withoutBrand.length > 0 ? withoutBrand : titled;
    const terms = fromTitle.length > 0 ? fromTitle : addressTerms(tab.url);
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);

    return {
      tab,
      order,
      terms,
      titleKey: terms.join(" "),
      termSource: fromTitle.length > 0 ? "title" : terms.length > 0 ? "address" : "none",
      siteTerms: [...new Set(domainTokens(site).map(stem))],
      site,
      siteName: site ? getDomainSectionName(site) : "Unknown site",
      genericSite: !site || isGenericSiteIdentity(site),
    };
  });
  for (const term of documentFrequency.keys()) if (!display.has(term)) display.set(term, titleCase(term));

  const index: TermIndex = {
    entries,
    byId: new Map(entries.map((entry) => [entry.tab.id, entry])),
    documentFrequency,
    display,
  };
  cache.set(snapshot, index);
  return index;
}

/** How a term is shown to a person: its first casing in a title. */
export function displayTerm(index: TermIndex, term: string): string {
  return index.display.get(term) ?? titleCase(term);
}

/** Rarer words say more: log-scaled inverse document frequency over the workspace. */
export function termWeight(index: TermIndex, term: string): number {
  const frequency = index.documentFrequency.get(term) ?? 0;
  return Math.log(1 + index.entries.length / Math.max(1, frequency));
}

/** A small, stable, non-cryptographic hash (FNV-1a, 48 bits as hex) for content-addressed ids. Equality, not secrecy. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${(b >>> 16).toString(16).padStart(4, "0")}`;
}

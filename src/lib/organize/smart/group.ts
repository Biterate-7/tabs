import { tokenize } from "../keywords";
import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "../domain-identity";
import { subjectName } from "@/lib/product/subjects";
import type { Collection } from "@/lib/collections/types";
import type { Workspace } from "@/lib/workspace/types";
import type { SmartDestination, SmartDuplicateSet, SmartExclusion, SmartGroup, SmartItem, SmartProposal } from "./types";

/**
 * Smart Organize's grouping: deterministic, local, and explainable.
 *
 * Nothing leaves the device and no model is asked. A tab is described only by
 * what Hubble already has — its title and its address — and two tabs belong
 * together when their titles share specific words. The steps:
 *
 *   1. Topic words. Each title loses the parts that only name the site
 *      ("… - YouTube", "… | Khan Academy"), common words and words that say
 *      what kind of page it is rather than what it is about ("notes",
 *      "worksheet", "past paper"). What is left is lightly stemmed.
 *   2. Similarity. Two tabs score by the words they share, weighted so a
 *      word few tabs use counts for more than one many tabs use (IDF-weighted
 *      Jaccard). A niche site counts a little too; a platform that hosts any
 *      topic (YouTube, Wikipedia, Google Docs, ChatGPT…) never does, so a
 *      physics lecture and a music video are not grouped for both being on
 *      YouTube.
 *   3. Groups. Average-linkage agglomerative clustering: the closest pair of
 *      groups merges while their average similarity clears a threshold. An
 *      average, not a single shared word, has to hold the group together, so
 *      one incidental word cannot chain unrelated tabs into one blob.
 *   4. Sites. Tabs left alone that share a site which IS the activity
 *      (Instagram, Netflix, a course site) form a group named after it.
 *   5. Everything else is left for the person to decide. A guess is never
 *      dressed up as a group.
 *
 * Names and reasons come only from the tabs' own words.
 */

/** Average similarity a group must keep to merge — see step 3. Tuned on group.test.ts's fixtures. */
export const MERGE_THRESHOLD = 0.25;
/** A niche site's identity counts as this fraction of a word. */
const SITE_WEIGHT = 0.6;
/**
 * A word only one tab uses cannot connect that tab to anything; it only says
 * how specific the title is. It still counts against similarity, at half
 * weight, so a long specific title is not held apart from a short one on the
 * same topic ("Derivative calculator" / "Chain rule for derivatives").
 */
const UNIQUE_WEIGHT = 0.5;
/** How well a group must match an existing subject or collection to go there instead of a new one. */
const DESTINATION_THRESHOLD = 1.2;
const MAX_NAME_LENGTH = 48;

/**
 * Hosts whose pages can be about anything: the site says nothing about the
 * topic, so it is never a grouping signal and never a group of its own.
 */
const TOPIC_PLATFORMS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "youtube.com",
  "youtu.be",
  "wikipedia.org",
  "docs.google.com",
  "drive.google.com",
  "classroom.google.com",
  "sheets.google.com",
  "slides.google.com",
  "forms.google.com",
  "scholar.google.com",
  "gemini.google.com",
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "perplexity.ai",
  "reddit.com",
  "old.reddit.com",
  "medium.com",
  "quizlet.com",
  "notion.so",
  "khanacademy.org",
  "quora.com",
  "stackexchange.com",
  "dropbox.com",
  "onedrive.live.com",
]);

/**
 * Words that say what kind of page something is, or nothing at all, rather
 * than what it is about. "Physics past paper" and "Chemistry past paper"
 * share two words and no topic.
 */
const GENERIC_WORDS = new Set([
  "unit", "chapter", "lesson", "part", "section", "topic", "note", "notes", "worksheet", "practice", "homework",
  "assignment", "video", "videos", "watch", "lecture", "introduction", "intro", "review", "quiz", "test", "exam",
  "class", "course", "tutorial", "explained", "explanation", "definition", "example", "examples", "problem",
  "problems", "question", "questions", "answer", "answers", "pdf", "online", "free", "best", "top", "tip", "tips",
  "way", "ways", "thing", "things", "complete", "full", "easy", "basic", "basics", "overview", "summary",
  "article", "blog", "post", "official", "site", "website", "login", "log", "sign", "dashboard", "account", "inbox",
  "document", "spreadsheet", "presentation", "copy", "draft", "edit", "view", "shared", "file", "files", "folder",
  "more", "all", "one", "two", "first", "day", "week", "year", "today", "via", "using", "use", "make", "made",
  "can", "will", "does", "did", "have", "has", "had", "just", "like", "also", "every", "any", "some", "than",
  "then", "there", "here", "which", "while", "revision", "revise", "study", "studies", "cheat", "sheet", "sheets",
  "flashcard", "flashcards", "resource", "resources", "material", "materials", "past", "paper", "papers", "mark",
  "scheme", "markscheme", "syllabus", "curriculum", "level", "levels", "grade", "grades", "igcse", "gcse",
  "alevel", "class", "student", "students", "teacher", "school", "chat", "conversation", "untitled", "home",
  "free", "live", "stream", "official", "episode", "playlist", "channel", "shorts", "reel", "reels",
  "story", "stories", "photo", "photos", "feed", "lab", "report",
]);

/** Splits "Topic - Site", "Topic | Site", "Topic — Site", "Topic · Site", "Topic » Site", "Site: Topic". */
const TITLE_SEPARATOR = /\s+[|\-–—·•:»]\s+|:\s+/;

/** Hosts where each subdomain is its own product (mail.google.com is not docs.google.com). */
const MULTI_PRODUCT = /(^|\.)(google|microsoft|live|office|apple|yahoo|amazon)\.[a-z.]+$/;
const SECOND_LEVEL = new Set(["co", "com", "ac", "org", "gov", "edu", "net", "sch"]);

/**
 * The site a host belongs to: apply.commonapp.org and commonapp.org are one
 * site; physics.stackexchange.com is Stack Exchange. Hosts whose subdomains
 * are separate products keep them.
 */
export function siteFamily(identity: string): string {
  if (MULTI_PRODUCT.test(identity)) return identity;
  const labels = identity.split(".");
  if (labels.length <= 2) return identity;
  const tld = labels.at(-1)!;
  const sld = labels.at(-2)!;
  return tld.length === 2 && SECOND_LEVEL.has(sld) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

function compact(text: string): string {
  return text.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
}

/** Light, symmetric stemming: enough that "derivatives" meets "derivative", never so much that two words collide. */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is|os)$/.test(token)) return token.slice(0, -1);
  return token;
}

function isGeneric(token: string): boolean {
  return GENERIC_WORDS.has(token) || GENERIC_WORDS.has(stem(token));
}

/** Whether a word says what kind of page something is rather than what it is about (see GENERIC_WORDS). */
export function isGenericWord(token: string): boolean {
  return isGeneric(token.toLowerCase());
}

export function isTopicPlatform(identity: string): boolean {
  return TOPIC_PLATFORMS.has(identity) || isGenericSiteIdentity(identity);
}

/** Whether one segment of a title is just the site's name. */
function namesTheSite(segment: string, identity: string): boolean {
  const text = compact(segment);
  if (!text) return true;
  const brand = compact(getDomainSectionName(identity));
  const host = compact(identity);
  const label = compact(identity.split(".")[0] ?? "");
  return text === brand || text === label || (text.length >= 5 && host.includes(text)) || (brand.length >= 4 && text === `${brand}com`);
}

function splitTitle(title: string, domain: string): { topic: string; segments: string[]; siteNames: string[] } {
  const identity = canonicalSiteIdentity(domain);
  const family = siteFamily(identity);
  const cleaned = title.replace(/^\(\d+\+?\)\s*/, "").trim();
  if (!cleaned) return { topic: "", segments: [], siteNames: [] };
  const segments = cleaned.split(TITLE_SEPARATOR).map((segment) => segment.trim()).filter(Boolean);
  const kept: string[] = [];
  const siteNames: string[] = [];
  for (const segment of segments) {
    if (namesTheSite(segment, identity) || (family !== identity && namesTheSite(segment, family))) siteNames.push(segment);
    else kept.push(segment);
  }
  return { topic: kept.join(" "), segments: kept, siteNames };
}

/** The part of a title that is about something: site names removed, "(3) " notification counts removed. */
export function topicText(title: string, domain: string): string {
  return splitTitle(title, domain).topic;
}

type Features = {
  item: SmartItem;
  identity: string;
  /** See siteFamily. */
  family: string;
  /** How the page's own title spells its site ("Common App"), when it does. */
  siteName?: string;
  /** Stemmed topic words, unique. */
  words: string[];
  /** Stemmed word → the first spelling seen in a title, for display. */
  spelling: Map<string, string>;
  /** The topic words in title order (stemmed), to order a two-word name the way titles say it. */
  order: string[];
  /** The title's topic parts as written, to name a group the way a title phrases it. */
  segments: string[];
};

function describe(item: SmartItem): Features {
  const identity = canonicalSiteIdentity(item.domain);
  const { topic: text, segments, siteNames } = splitTitle(item.title, item.domain);
  const siteName = siteNames
    .map((name) => name.replace(/^the\s+/i, ""))
    .find((name) => name.length <= 32 && name.split(/\s+/).length <= 4 && /[a-z]/i.test(name) && !name.includes("@"));
  const spelling = new Map<string, string>();
  const order: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    const [token] = tokenize(raw);
    if (!token || isGeneric(token)) continue;
    const stemmed = stem(token);
    if (!spelling.has(stemmed)) spelling.set(stemmed, raw);
    if (!order.includes(stemmed)) order.push(stemmed);
  }
  return { item, identity, family: siteFamily(identity), ...(siteName ? { siteName } : {}), words: order, spelling, order, segments };
}

/**
 * A title's topic words exactly as grouping sees them — stemmed, site names
 * and generic words removed — with the first spelling of each for display.
 * Shared with the context engine (lib/intelligence), so a page is described
 * the same way wherever Hubble compares it.
 */
export function titleTopicWords(title: string, domain: string): { words: string[]; spelling: Map<string, string>; family: string; identity: string } {
  const f = describe({ id: "", url: "", normalizedUrl: "", resourceKey: "", domain, title: title.trim() });
  return { words: f.words, spelling: f.spelling, family: f.family, identity: f.identity };
}

const siteToken = (identity: string) => `site:${identity}`;

/** Each item's weighted terms: its topic words, and its site when the site says something about the topic. */
function weightedTerms(features: readonly Features[]): Map<string, number>[] {
  const termsOf = features.map((f) => {
    const terms = [...f.words];
    if (!isTopicPlatform(f.identity) && !isTopicPlatform(f.family)) terms.push(siteToken(f.family));
    return terms;
  });
  const df = new Map<string, number>();
  for (const terms of termsOf) for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  const n = features.length;
  return termsOf.map((terms) => {
    const weights = new Map<string, number>();
    for (const term of terms) {
      const count = df.get(term) ?? 1;
      const site = term.startsWith("site:");
      // A site no other tab is on says nothing at all.
      if (site && count < 2) continue;
      const idf = Math.log(1 + n / count) * (count < 2 ? UNIQUE_WEIGHT : 1);
      weights.set(term, site ? idf * SITE_WEIGHT : idf);
    }
    return weights;
  });
}

/** Pairwise IDF-weighted Jaccard, as a flat n×n matrix. */
function similarities(weights: readonly Map<string, number>[]): Float64Array {
  const n = weights.length;
  const sim = new Float64Array(n * n);
  const totals = weights.map((w) => [...w.values()].reduce((sum, value) => sum + value, 0));
  const postings = new Map<string, number[]>();
  weights.forEach((w, index) => {
    for (const term of w.keys()) {
      const list = postings.get(term);
      if (list) list.push(index);
      else postings.set(term, [index]);
    }
  });
  const shared = new Float64Array(n * n);
  for (const [term, list] of postings) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const i = list[a]!;
        const j = list[b]!;
        // Same term, same weight in both (it is a function of the term alone).
        shared[i * n + j] += weights[i]!.get(term)!;
      }
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const common = shared[i * n + j]!;
      if (common === 0) continue;
      const union = totals[i]! + totals[j]! - common;
      const value = union > 0 ? common / union : 0;
      sim[i * n + j] = value;
      sim[j * n + i] = value;
    }
  }
  return sim;
}

/** Average-linkage agglomerative clustering, deterministic (ties go to the lower index). Returns clusters of item indexes. */
function cluster(sim: Float64Array, n: number, threshold: number): number[][] {
  const members: number[][] = Array.from({ length: n }, (_, index) => [index]);
  const active = new Array<boolean>(n).fill(true);
  // Sum of pairwise similarity between cluster a and cluster b.
  const total = Float64Array.from(sim);
  for (;;) {
    let best = -1;
    let bestA = -1;
    let bestB = -1;
    for (let a = 0; a < n; a += 1) {
      if (!active[a]) continue;
      const sizeA = members[a]!.length;
      for (let b = a + 1; b < n; b += 1) {
        if (!active[b]) continue;
        const sum = total[a * n + b]!;
        if (sum === 0) continue;
        const average = sum / (sizeA * members[b]!.length);
        if (average > best) {
          best = average;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || best < threshold) break;
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === bestA || k === bestB) continue;
      const merged = total[bestA * n + k]! + total[bestB * n + k]!;
      total[bestA * n + k] = merged;
      total[k * n + bestA] = merged;
    }
    members[bestA] = [...members[bestA]!, ...members[bestB]!].sort((x, y) => x - y);
    active[bestB] = false;
  }
  return members.filter((_, index) => active[index]);
}

/** Capitalizes the first letter — but never an identifier like "useEffect" or "iPhone", whose case is the name. */
function capitalize(word: string): string {
  if (!word || /[A-Z]/.test(word.slice(1, word.indexOf(" ") === -1 ? undefined : word.indexOf(" ")))) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}

/** Short words a title uses inside a name ("Treaty of Versailles"); kept only when a title puts them there. */
const CONNECTORS = new Set(["of", "the", "and", "in", "on", "for", "to", "de", "la", "le", "du", "des", "&"]);

/**
 * The connecting words a title uses between the name's words, if some title
 * says them as one phrase ("Treaty of Versailles"): one entry per gap, null
 * where the words are adjacent. Null when no title has them together.
 */
function connectorsBetween(features: readonly Features[], words: readonly string[]): (string | null)[] | null {
  if (words.length < 2) return null;
  const stemOf = (raw: string) => {
    const [token] = tokenize(raw);
    return token ? stem(token) : null;
  };
  for (const f of features) {
    for (const segment of f.segments) {
      const raw = segment.split(/\s+/).map((part) => part.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&]+$/g, "")).filter(Boolean);
      const stems = raw.map(stemOf);
      for (let start = 0; start < raw.length; start += 1) {
        if (stems[start] !== words[0]) continue;
        const gaps: (string | null)[] = [];
        let position = start;
        for (const word of words.slice(1)) {
          if (stems[position + 1] === word) {
            gaps.push(null);
            position += 1;
          } else if (CONNECTORS.has(raw[position + 1]?.toLowerCase() ?? "") && stems[position + 2] === word) {
            gaps.push(raw[position + 1]!.toLowerCase());
            position += 2;
          } else break;
        }
        if (gaps.length === words.length - 1) return gaps;
      }
    }
  }
  return null;
}


/** `keyWords`: the group's shared words, most-shared first; `coverage`: how many of its tabs use each. */
type Naming = { name: string; reason: string; keyWords: string[]; coverage: number[] };

/** A topic group's name and reason, from the words most of its tabs share. */
function nameTopic(features: readonly Features[]): Naming | null {
  const coverage = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const f of features) {
    for (const word of f.words) {
      coverage.set(word, (coverage.get(word) ?? 0) + 1);
      if (!firstSeen.has(word)) firstSeen.set(word, order++);
    }
  }
  const shared = [...coverage.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!);
  if (shared.length === 0) return null;

  const [top, topCount] = shared[0]!;
  // Another word joins the name only when it travels with the ones before it in nearly all of the group ("Simple harmonic motion").
  const words = [top];
  for (const [word, count] of shared.slice(1)) {
    if (words.length === 3) break;
    if (count < Math.max(2, Math.ceil(features.length * 0.75))) continue;
    const together = features.filter((f) => [...words, word].every((w) => f.words.includes(w))).length;
    if (together >= Math.ceil(topCount * 0.6)) words.push(word);
  }
  // Say them in the order titles do: "Projectile motion", not "Motion projectile".
  const witness = features.find((f) => words.every((word) => f.order.includes(word)));
  if (witness) words.sort((a, b) => witness.order.indexOf(a) - witness.order.indexOf(b));
  const spell = (word: string) => features.find((f) => f.spelling.has(word))?.spelling.get(word) ?? word;
  // Sentence case, except where every title capitalizes a later word (a name: "French Revolution").
  const lowered = (word: string) => features.some((f) => f.spelling.get(word) === f.spelling.get(word)?.toLowerCase() && f.spelling.has(word));
  const display = words.map((word, index) => (index > 0 && lowered(word) ? spell(word).toLowerCase() : spell(word)));
  const gaps = connectorsBetween(features, words);
  const phrase = display.map((word, index) => (index > 0 && gaps?.[index - 1] ? `${gaps[index - 1]} ${word}` : word)).join(" ");
  const name = capitalize(phrase).slice(0, MAX_NAME_LENGTH);
  const evidence = shared.slice(0, 3).map(([word]) => `“${spell(word)}”`);
  const reason = evidence.length === 1 ? `Titles mention ${evidence[0]}` : `Titles mention ${evidence.slice(0, -1).join(", ")} and ${evidence.at(-1)}`;
  const key = shared.slice(0, 5);
  return { name, reason, keyWords: key.map(([word]) => word), coverage: key.map(([, count]) => count) };
}

/** A site group's name: how its pages spell the site ("Common App"), else Hubble's name for the domain. */
function siteNaming(members: readonly Features[]): Naming {
  const counts = new Map<string, { spelling: string; count: number }>();
  for (const f of members) {
    if (!f.siteName) continue;
    const key = compact(f.siteName);
    const entry = counts.get(key) ?? { spelling: f.siteName, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const spelled = [...counts.values()].sort((a, b) => b.count - a.count)[0]?.spelling;
  const name = (spelled ?? getDomainSectionName(members[0]!.family)).slice(0, MAX_NAME_LENGTH);
  return { name, reason: `All from ${name}`, keyWords: [], coverage: [] };
}

/** Where a group goes by default: the existing place it clearly belongs to, or a new one named after it. */
function bestDestination(
  naming: { name: string; keyWords: string[]; coverage: number[]; identity?: string },
  places: readonly { id: string; name: string; words: Set<string>; sites: Set<string> }[]
): string | null {
  const groupName = compact(naming.name);
  let best: { id: string; score: number } | null = null;
  for (const place of places) {
    let score: number;
    if (compact(place.name) === groupName) score = 100;
    else {
      const nameWords = tokenize(place.name).filter((word) => !isGeneric(word)).map(stem);
      const nameHit = nameWords.length > 0 ? nameWords.filter((word) => naming.keyWords.includes(word)).length / nameWords.length : 0;
      // Share of the group's word use the place already has: the word every tab shares counts for more than one two tabs share.
      const total = naming.coverage.reduce((sum, count) => sum + count, 0);
      const contentHit = total > 0 ? naming.keyWords.reduce((sum, word, index) => sum + (place.words.has(word) ? naming.coverage[index]! : 0), 0) / total : 0;
      const siteHit = naming.identity && place.sites.has(naming.identity) ? 1 : 0;
      score = nameHit * 2 + contentHit * 2 + siteHit * 1.5;
    }
    if (score >= DESTINATION_THRESHOLD && (!best || score > best.score)) best = { id: place.id, score };
  }
  return best?.id ?? null;
}

function placeProfile(id: string, name: string, tabs: readonly { title?: string; domain: string }[]) {
  const words = new Set<string>();
  const siteCounts = new Map<string, number>();
  for (const tab of tabs) {
    const f = describe({ id: "", url: "", normalizedUrl: "", resourceKey: "", domain: tab.domain, title: tab.title?.trim() ?? "" });
    for (const word of f.words) words.add(word);
    if (!isTopicPlatform(f.identity)) siteCounts.set(f.family, (siteCounts.get(f.family) ?? 0) + 1);
  }
  // A site "belongs" to a place when it is a real share of it, not one stray tab.
  const sites = new Set([...siteCounts].filter(([identity, count]) => !isTopicPlatform(identity) && count >= Math.max(2, tabs.length * 0.3)).map(([identity]) => identity));
  return { id, name, words, sites };
}

/** Pages open more than once: same source identity (what Hubble's duplicate rule uses). */
export function findDuplicateSets(items: readonly SmartItem[]): SmartDuplicateSet[] {
  const byKey = new Map<string, SmartItem[]>();
  for (const item of items) {
    const bucket = byKey.get(item.resourceKey);
    if (bucket) bucket.push(item);
    else byKey.set(item.resourceKey, [item]);
  }
  const sets: SmartDuplicateSet[] = [];
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    sets.push({ itemIds: bucket.map((item) => item.id), exact: bucket.every((item) => item.normalizedUrl === bucket[0]!.normalizedUrl) });
  }
  return sets;
}

export type SmartContext =
  | { mode: "open-tabs"; subjects: readonly Workspace[] }
  | { mode: "subject"; workspace: Workspace; collections: readonly Collection[] };

/**
 * A proposal for `items`. Read-only: it describes what could change and
 * changes nothing. Items already organized by the person (saved as a source,
 * or in a collection) are left out by default, so confirming the proposal
 * untouched never duplicates or reshuffles their work.
 */
export function proposeSmartOrganization(items: readonly SmartItem[], context: SmartContext, options: { truncated?: number } = {}): SmartProposal {
  const excluded: SmartExclusion[] = [];
  const candidates: SmartItem[] = [];
  for (const item of items) {
    if (context.mode === "open-tabs" && item.savedIn) excluded.push({ itemId: item.id, reason: "already-saved" });
    else if (context.mode === "subject" && item.inCollection) excluded.push({ itemId: item.id, reason: "already-in-collection" });
    else candidates.push(item);
  }

  const features = candidates.map(describe);
  const n = features.length;
  const clusters = n >= 2 ? cluster(similarities(weightedTerms(features)), n, MERGE_THRESHOLD) : features.map((_, index) => [index]);

  type Draft = { naming: Naming; identity?: string; indexes: number[] };
  const drafts: Draft[] = [];
  const alone: number[] = [];
  for (const indexes of clusters) {
    if (indexes.length < 2) {
      alone.push(...indexes);
      continue;
    }
    const members = indexes.map((index) => features[index]!);
    const families = new Set(members.map((f) => f.family));
    const topic = nameTopic(members);
    if (topic) drafts.push({ naming: topic, indexes });
    // Held together by a niche site alone: name it after the site.
    else if (families.size === 1) drafts.push({ naming: siteNaming(members), identity: members[0]!.family, indexes });
    else alone.push(...indexes);
  }

  // Step 4: a site that is the activity itself.
  const bySite = new Map<string, number[]>();
  for (const index of alone) {
    const { identity, family } = features[index]!;
    if (isTopicPlatform(identity) || isTopicPlatform(family)) continue;
    const bucket = bySite.get(family);
    if (bucket) bucket.push(index);
    else bySite.set(family, [index]);
  }
  const placed = new Set<number>();
  for (const [family, indexes] of bySite) {
    if (indexes.length < 2) continue;
    drafts.push({ naming: siteNaming(indexes.map((index) => features[index]!)), identity: family, indexes });
    for (const index of indexes) placed.add(index);
  }
  const review = alone.filter((index) => !placed.has(index)).sort((a, b) => a - b).map((index) => features[index]!.item.id);

  // Biggest first; equal sizes in the order their first tab arrived.
  drafts.sort((a, b) => b.indexes.length - a.indexes.length || a.indexes[0]! - b.indexes[0]!);

  // Two groups never share a name: a second "Essay" would silently land in the first one's subject.
  const taken = new Set<string>();
  for (const draft of drafts) {
    let name = draft.naming.name;
    for (let suffix = 2; taken.has(compact(name)); suffix += 1) name = `${draft.naming.name} ${suffix}`;
    taken.add(compact(name));
    draft.naming = { ...draft.naming, name };
  }

  const places =
    context.mode === "open-tabs"
      ? context.subjects.map((workspace) => placeProfile(workspace.id, subjectName(workspace), workspace.tabs))
      : context.collections
          .filter((collection) => collection.workspaceId === context.workspace.id)
          .map((collection) => {
            const tabsById = new Map(context.workspace.tabs.map((tab) => [tab.id, tab]));
            const tabs = collection.tabIds.map((id) => tabsById.get(id)).filter((tab) => tab !== undefined);
            return placeProfile(collection.id, collection.name, tabs);
          });

  const groups: SmartGroup[] = drafts.map((draft, index) => {
    const match = bestDestination({ ...draft.naming, ...(draft.identity ? { identity: draft.identity } : {}) }, places);
    const destination: SmartDestination =
      context.mode === "open-tabs"
        ? match
          ? { kind: "subject", workspaceId: match }
          : { kind: "new-subject" }
        : match
          ? { kind: "collection", collectionId: match }
          : { kind: "new-collection" };
    return {
      id: `group-${index + 1}`,
      name: draft.naming.name,
      reason: draft.naming.reason,
      itemIds: draft.indexes.map((i) => features[i]!.item.id),
      destination,
    };
  });

  return {
    mode: context.mode,
    items: [...items],
    groups,
    review,
    excluded,
    duplicates: findDuplicateSets(items),
    truncated: options.truncated ?? 0,
  };
}

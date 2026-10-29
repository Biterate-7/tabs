import { tokenize } from "@/lib/organize/keywords"
import { isGenericWord, isTopicPlatform, stem, titleTopicWords } from "@/lib/organize/smart/group"
import { subjectName } from "@/lib/product/subjects"
import { sourceKey } from "@/lib/resources/url"
import type { Workspace } from "@/lib/workspace/types"
import type { ActivityRecord } from "./types"

/**
 * What a page or a project is about, as weighted topic words — the only
 * thing the engine compares. Built from what Hubble actually holds:
 *
 *   a page      its title's topic words (Smart Organize's own reading of a
 *               title: site names, generic words and page-type words gone),
 *               plus the topic words read from its text when the extension
 *               read it with permission
 *   a project   its name, its brief, the titles of everything in it, and
 *               the pages the person confirmed belong to it
 *
 * No text is ever invented and nothing leaves the device.
 */

export type Terms = Map<string, number>

/** A word of the title. */
const TITLE_WEIGHT = 1
/** A word only read from the text: real evidence, but about a whole conversation, not its subject line. */
const CONTENT_WEIGHT = 0.6
/** A niche site's identity (never a platform that hosts any topic). */
const SITE_WEIGHT = 0.35
const NAME_WEIGHT = 2.5
const BRIEF_WEIGHT = 1.2
const ITEM_WEIGHT = 1
const NOTE_WEIGHT = 0.8
const CONFIRMED_WEIGHT = 1

export type RecordFeatures = {
  key: string
  terms: Terms
  /** Stemmed word → how a title or the text spelled it. */
  spelling: Map<string, string>
  /** Whether any weight came from the page's text. */
  fromContent: boolean
  /** The title's topic words in the order the title says them. */
  order: string[]
}

export type ProjectFeatures = {
  workspaceId: string
  name: string
  terms: Terms
  /** The stemmed words of the project's own name. */
  nameTerms: string[]
  spelling: Map<string, string>
  /** Every source identity already in the project. */
  keys: Set<string>
}

/**
 * Smart Organize's stemmer keeps "taxes" as "taxe", so "tax" and "taxes" never
 * meet. Context matching folds the "-es" plurals of words ending in x, ch, sh,
 * ss and z first ("taxes" → "tax", "churches" → "church"); Smart Organize's own
 * grouping is left exactly as it is.
 */
export function topicStem(raw: string): string {
  const lower = raw.toLowerCase()
  return stem(/(x|ch|sh|ss|z)es$/.test(lower) && lower.length > 4 ? lower.slice(0, -2) : lower)
}

/**
 * Words research pages use whatever they are about ("Evidence on…", "Does it
 * work?", "New analysis of…"). Smart Organize's generic list covers page types;
 * these are the research genre's own, and say nothing about the topic.
 */
const RESEARCH_GENRE = new Set(["work", "evidence", "research", "analysis", "data", "finding", "insight", "journal", "new", "latest", "impact", "effect", "effective", "role", "case", "help", "need", "know", "really", "better", "good", "great", "thing", "help", "idea"])

function isContextGeneric(word: string): boolean {
  return RESEARCH_GENRE.has(word) || isGenericWord(word)
}

/** A title's topic words, with plural folding (see topicStem). */
function titleWords(title: string, domain: string) {
  const read = titleTopicWords(title, domain)
  const words: string[] = []
  const spelling = new Map<string, string>()
  for (const word of read.words) {
    const raw = read.spelling.get(word) ?? word
    const folded = topicStem(raw)
    if (isContextGeneric(folded)) continue
    if (!words.includes(folded)) words.push(folded)
    if (!spelling.has(folded)) spelling.set(folded, raw)
  }
  return { words, spelling, identity: read.identity, family: read.family }
}

function add(terms: Terms, term: string, weight: number) {
  terms.set(term, (terms.get(term) ?? 0) + weight)
}

/** Ordinary words of free text, the way titles are read: tokenized, generic words out, stemmed. */
export function textTerms(text: string): { words: string[]; spelling: Map<string, string> } {
  const spelling = new Map<string, string>()
  const words: string[] = []
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    const [token] = tokenize(raw)
    if (!token || isGenericWord(token)) continue
    const stemmed = topicStem(token)
    if (isContextGeneric(stemmed)) continue
    if (!spelling.has(stemmed)) spelling.set(stemmed, raw)
    words.push(stemmed)
  }
  return { words, spelling }
}

export function recordFeatures(record: ActivityRecord): RecordFeatures {
  const terms: Terms = new Map()
  const spelling = new Map<string, string>()
  const title = titleWords(record.title, record.domain)
  for (const word of title.words) add(terms, word, TITLE_WEIGHT)
  for (const [word, spelled] of title.spelling) spelling.set(word, spelled)
  let fromContent = false
  for (const raw of record.terms ?? []) {
    if (isGenericWord(raw)) continue
    const word = topicStem(raw)
    if (isContextGeneric(word)) continue
    if (word.length < 3) continue
    fromContent = true
    // Already in the title: the text agrees, a little more weight. Otherwise its own, smaller weight.
    add(terms, word, terms.has(word) ? CONTENT_WEIGHT / 2 : CONTENT_WEIGHT)
    if (!spelling.has(word)) spelling.set(word, raw)
  }
  if (!isTopicPlatform(title.identity) && !isTopicPlatform(title.family)) add(terms, `site:${title.family}`, SITE_WEIGHT)
  return { key: record.key, terms, spelling, fromContent, order: title.words }
}

/** Words of many titles: each counts once per title, and a word every title uses doesn't swamp the profile. */
function addTitles(terms: Terms, spelling: Map<string, string>, titles: readonly { title: string; domain: string }[], weight: number) {
  const counts = new Map<string, number>()
  for (const entry of titles) {
    const read = titleWords(entry.title, entry.domain)
    for (const word of new Set(read.words)) counts.set(word, (counts.get(word) ?? 0) + 1)
    for (const [word, spelled] of read.spelling) if (!spelling.has(word)) spelling.set(word, spelled)
  }
  for (const [word, count] of counts) add(terms, word, weight * (1 + Math.log(count)))
}

export function projectFeatures(workspace: Workspace, confirmed: readonly RecordFeatures[] = []): ProjectFeatures {
  const terms: Terms = new Map()
  const spelling = new Map<string, string>()
  const name = subjectName(workspace)
  const own = textTerms(name)
  for (const word of new Set(own.words)) add(terms, word, NAME_WEIGHT)
  for (const [word, spelled] of own.spelling) spelling.set(word, spelled)
  const brief = [workspace.brief?.focus, workspace.brief?.description].filter(Boolean).join(" ")
  if (brief) {
    const read = textTerms(brief)
    for (const word of new Set(read.words)) add(terms, word, BRIEF_WEIGHT)
    for (const [word, spelled] of read.spelling) if (!spelling.has(word)) spelling.set(word, spelled)
  }
  addTitles(
    terms,
    spelling,
    workspace.tabs.map((tab) => ({ title: tab.title ?? "", domain: tab.domain })),
    ITEM_WEIGHT
  )
  addTitles(
    terms,
    spelling,
    (workspace.notes ?? []).map((note) => ({ title: note.title ?? "", domain: "" })),
    NOTE_WEIGHT
  )
  for (const page of confirmed) {
    for (const [term, weight] of page.terms) if (!term.startsWith("site:")) add(terms, term, Math.min(weight, 1) * CONFIRMED_WEIGHT)
    for (const [word, spelled] of page.spelling) if (!spelling.has(word)) spelling.set(word, spelled)
  }
  return {
    workspaceId: workspace.id,
    name,
    terms,
    nameTerms: [...new Set(own.words)],
    spelling,
    keys: new Set(workspace.tabs.map((tab) => sourceKey(tab.url)).filter((key): key is string => key !== undefined)),
  }
}

/**
 * Inverse document frequency over everything compared in one run: a word
 * that every page and project uses tells them apart from nothing.
 */
export function inverseFrequencies(documents: readonly Terms[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const terms of documents) for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const n = Math.max(documents.length, 1)
  const idf = new Map<string, number>()
  for (const [term, count] of df) idf.set(term, Math.log(1 + n / count))
  return idf
}

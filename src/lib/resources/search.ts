import { formatTimestamp } from "./transcript";
import type { Tab } from "@/lib/tabs/types";
import type { ResourceContent, TranscriptSegment } from "./types";

/**
 * Searching one project: every source's title, address and notes, the text
 * Hubble extracted from it (page text, each PDF page, transcript lines), and
 * the project's previous agent results.
 *
 * Plain term matching, not embeddings: it runs on this device over content
 * that never leaves it, it is exact about *where* a match is (a PDF page, a
 * transcript time), and it needs no service. Every term must appear in the
 * same place for a hit; hits are ranked by how many times the terms occur
 * and where (a title outranks body text).
 *
 * Scoped by construction: it is handed one project's tabs and that project's
 * contents, and has no way to reach any other. Whatever the caller leaves
 * out of `tabs` (a removed source, a filter) is never searched, even if its
 * content is still in the store.
 *
 * ## Transcripts: moments, not lines
 *
 * A transcript is searched as *passages* — a line and the two after it, so a
 * phrase split across caption lines still matches — anchored on a line that
 * says one of the words. A hit's time is that line's, so "at 8:42" is when
 * it is said. Overlapping and back-to-back hits are one passage (one result,
 * its strongest line), the words in the order typed rank above the same
 * words scattered, and one video yields at most a few moments, so a single
 * long lecture cannot crowd out the rest.
 */

export type SearchLocation =
  | { kind: "title" }
  | { kind: "address" }
  | { kind: "notes" }
  | { kind: "text" }
  | { kind: "page"; page: number }
  /** `line` is the transcript line the moment starts on; `end` when the passage's end is known. */
  | { kind: "transcript"; start?: number; end?: number; line: number };

export type ProjectSearchHit =
  | { type: "source"; tabId: string; location: SearchLocation; snippet: string; score: number }
  | { type: "result"; id: string; snippet: string; score: number };

export type SearchableResult = { id: string; text: string };

const MAX_HITS = 50;
const SNIPPET_RADIUS = 80;
/** A transcript passage: at most this many lines… */
const PASSAGE_LINES = 3;
/** …said within this many seconds of the first — so a pause or a cut never joins two separate moments. */
const PASSAGE_SECONDS = 20;
/** Hits this close in time are the same explanation… */
const MERGE_GAP_SECONDS = 15;
/** …up to this long; past it a run of mentions is split into separate moments. */
const MAX_MOMENT_SECONDS = 90;
const MOMENTS_PER_SOURCE = 5;
/** The words in the order typed, together: worth this many extra occurrences per word. */
const PHRASE_BONUS = 4;

const NON_WORD = /[^\p{L}\p{N}]+/gu;

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1))].slice(0, 8);
}

/** The query's words in order, for phrase matching ("Gravitational  Potential-Energy" → "gravitational potential energy"). */
export function searchPhrase(query: string): string {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  for (let index = haystack.indexOf(term); index !== -1; index = haystack.indexOf(term, index + term.length)) count += 1;
  return count;
}

function scoreOf(text: string, terms: readonly string[]): number {
  return scoreLower(text.toLowerCase(), terms);
}

/** scoreOf for text that is already lower case (normalized transcript passages). */
function scoreLower(lower: string, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    const count = occurrences(lower, term);
    if (count === 0) return 0;
    score += count;
  }
  return score;
}

/**
 * The words around a match, cut at word boundaries. `span` is how much to
 * keep before and after the match's start; a transcript leans forward, since
 * an explanation follows the words that name it.
 */
export function snippetAround(text: string, terms: readonly string[], phrase?: string, span: { before: number; after: number } = { before: SNIPPET_RADIUS, after: SNIPPET_RADIUS }): string {
  const lower = text.toLowerCase();
  // Centre on the words as typed when they appear together, else on the first word found.
  const together = phrase && phrase.includes(" ") ? lower.indexOf(phrase) : -1;
  const first = together >= 0 ? together : Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
  if (!Number.isFinite(first)) return text.slice(0, span.before + span.after).replace(/\s+/g, " ").trim();
  let start = Math.max(0, first - span.before);
  let end = Math.min(text.length, first + span.after);
  // Whole words only: move each cut to the nearest space, within reason.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > first) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

const MOMENT_SNIPPET = { before: 60, after: 180 } as const;

/** A line as search sees it — lower case, punctuation as spaces, padded — cached per stored transcript. */
const normalizedLines = new WeakMap<readonly TranscriptSegment[], string[]>();

function normalized(lines: readonly TranscriptSegment[]): string[] {
  let out = normalizedLines.get(lines);
  if (!out) {
    out = lines.map((line) => ` ${line.text.toLowerCase().replace(NON_WORD, " ").trim()} `);
    normalizedLines.set(lines, out);
  }
  return out;
}

export type TranscriptMoment = { line: number; start?: number; end?: number; score: number; snippet: string };

/**
 * The moments in one transcript where every term is said within one
 * passage, strongest first. Normalization is cached per transcript, so each
 * keystroke re-scans text but never re-processes it.
 */
export function transcriptMoments(
  lines: readonly TranscriptSegment[],
  terms: readonly string[],
  phrase: string = terms.join(" "),
  limit: number = MOMENTS_PER_SOURCE
): TranscriptMoment[] {
  if (terms.length === 0 || lines.length === 0) return [];
  const norm = normalized(lines);
  const wantsPhrase = phrase.includes(" ");
  // One past the last line of the passage that starts at `index`.
  const passageEnd = (index: number) => {
    const from = lines[index]!.start;
    let end = index + 1;
    while (end < lines.length && end - index < PASSAGE_LINES) {
      const at = lines[end]!.start;
      if (from !== undefined && at !== undefined && at - from > PASSAGE_SECONDS) break;
      end += 1;
    }
    return end;
  };

  const anchors: { line: number; score: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!terms.some((term) => norm[index]!.includes(term))) continue;
    const passage = norm.slice(index, passageEnd(index)).join(" ").replace(/ +/g, " ");
    const score = scoreLower(passage, terms);
    if (score === 0) continue;
    // The moment is where the words begin: the phrase bonus goes to the line it starts on, and a line
    // that says more of the words itself beats one that only borrows them from the next.
    const own = norm[index]!;
    const phraseAt = wantsPhrase ? passage.indexOf(` ${phrase}`) : -1;
    const startsHere = phraseAt >= 0 && phraseAt < own.length - 1;
    const said = terms.filter((term) => own.includes(term)).length;
    anchors.push({ line: index, score: score + said + (startsHere ? PHRASE_BONUS * terms.length : 0) });
  }

  // One passage, one result: chain hits that overlap or follow closely, keep each chain's strongest line.
  const startOf = (line: number) => lines[line]!.start;
  const chains: { first: number; last: number; best: { line: number; score: number } }[] = [];
  for (const anchor of anchors) {
    const chain = chains[chains.length - 1];
    const at = startOf(anchor.line);
    const overlapping = chain !== undefined && anchor.line < passageEnd(chain.last);
    const soonAfter = chain !== undefined && at !== undefined && startOf(chain.last) !== undefined && at - startOf(chain.last)! <= MERGE_GAP_SECONDS;
    const tooLong = chain !== undefined && at !== undefined && startOf(chain.first) !== undefined && at - startOf(chain.first)! > MAX_MOMENT_SECONDS;
    if (chain && (overlapping || soonAfter) && !tooLong) {
      chain.last = anchor.line;
      if (anchor.score > chain.best.score) chain.best = anchor;
    } else {
      chains.push({ first: anchor.line, last: anchor.line, best: anchor });
    }
  }

  return chains
    .map(({ best }) => {
      const line = lines[best.line]!;
      const stop = passageEnd(best.line);
      const end = lines[stop - 1]!.end ?? lines[stop]?.start;
      // The line before (when it leads straight in) and the passage: enough around the words to make sense of them.
      const previous = lines[best.line - 1];
      const leadsIn = previous && (previous.start === undefined || line.start === undefined || line.start - previous.start <= PASSAGE_SECONDS);
      const context = lines
        .slice(leadsIn ? best.line - 1 : best.line, stop)
        .map((entry) => entry.text)
        .join(" ");
      return {
        line: best.line,
        ...(line.start !== undefined ? { start: line.start } : {}),
        ...(line.start !== undefined && end !== undefined && end > line.start ? { end } : {}),
        score: best.score,
        snippet: snippetAround(context, terms, phrase, MOMENT_SNIPPET),
      };
    })
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit);
}

/**
 * Text split into the parts that match a search and the parts that do not,
 * for highlighting as plain text — never as markup.
 */
export function markMatches(text: string, terms: readonly string[]): { text: string; match: boolean }[] {
  const wanted = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (wanted.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let plain = 0;
  let index = 0;
  while (index < text.length) {
    const term = wanted.find((candidate) => lower.startsWith(candidate, index));
    if (!term) {
      index += 1;
      continue;
    }
    if (index > plain) parts.push({ text: text.slice(plain, index), match: false });
    parts.push({ text: text.slice(index, index + term.length), match: true });
    index += term.length;
    plain = index;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain), match: false });
  return parts;
}

/** Where a hit is, in words: "page 4", "at 3:12". */
export function describeLocation(location: SearchLocation): string | undefined {
  if (location.kind === "page") return `page ${location.page}`;
  if (location.kind === "transcript") return location.start !== undefined ? `at ${formatTimestamp(location.start)}` : "in the transcript";
  return undefined;
}

export function searchProject(input: {
  query: string;
  tabs: readonly Pick<Tab, "id" | "title" | "url" | "domain" | "notes" | "resource">[];
  contents: ReadonlyMap<string, ResourceContent>;
  results?: readonly SearchableResult[];
  limit?: number;
}): ProjectSearchHit[] {
  const terms = searchTerms(input.query);
  if (terms.length === 0) return [];
  const phrase = searchPhrase(input.query);
  const hits: ProjectSearchHit[] = [];
  const push = (tabId: string, location: SearchLocation, text: string, weight: number) => {
    const score = scoreOf(text, terms);
    if (score > 0) hits.push({ type: "source", tabId, location, snippet: snippetAround(text, terms, phrase), score: score * weight });
  };

  for (const tab of input.tabs) {
    if (!tab.resource) continue;
    if (tab.title) push(tab.id, { kind: "title" }, tab.title, 10);
    push(tab.id, { kind: "address" }, `${tab.domain} ${tab.url}`, 4);
    if (tab.notes) push(tab.id, { kind: "notes" }, tab.notes, 6);
    const content = input.contents.get(tab.id);
    if (!content) continue;
    if (content.text) push(tab.id, { kind: "text" }, content.text, 1);
    content.pages?.forEach((page, index) => push(tab.id, { kind: "page", page: index + 1 }, page, 1));
    for (const moment of transcriptMoments(content.transcript ?? [], terms, phrase)) {
      hits.push({
        type: "source",
        tabId: tab.id,
        location: { kind: "transcript", line: moment.line, ...(moment.start !== undefined ? { start: moment.start } : {}), ...(moment.end !== undefined ? { end: moment.end } : {}) },
        snippet: moment.snippet,
        score: moment.score,
      });
    }
  }
  for (const result of input.results ?? []) {
    const score = scoreOf(result.text, terms);
    if (score > 0) hits.push({ type: "result", id: result.id, snippet: snippetAround(result.text, terms, phrase), score: score * 3 });
  }

  // Strongest first; within a source, each place once (a page, a transcript moment).
  return rank(hits, input.limit ?? MAX_HITS);
}

export type TranscriptSearchHit = {
  workspaceId: string;
  tabId: string;
  location: Extract<SearchLocation, { kind: "transcript" }>;
  snippet: string;
  score: number;
};

/**
 * Moments across several subjects' transcripts — what ⌘K shows. Each
 * subject is searched on its own with `searchProject` (so the same rules,
 * ranking and isolation apply), only through the sources it still has, and
 * only for what was said: titles and pages are the subject's own search.
 */
export function searchTranscripts(input: {
  query: string;
  workspaces: readonly { id: string; tabs: readonly Pick<Tab, "id" | "title" | "url" | "domain" | "notes" | "resource">[] }[];
  contents: ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>;
  limit?: number;
}): TranscriptSearchHit[] {
  if (searchTerms(input.query).length === 0) return [];
  const all: TranscriptSearchHit[] = [];
  for (const workspace of input.workspaces) {
    const contents = input.contents.get(workspace.id);
    if (!contents || contents.size === 0) continue;
    const tabs = workspace.tabs.filter((tab) => tab.resource && contents.get(tab.id)?.transcript?.length);
    if (tabs.length === 0) continue;
    for (const hit of searchProject({ query: input.query, tabs, contents, limit: MAX_HITS })) {
      if (hit.type !== "source" || hit.location.kind !== "transcript") continue;
      all.push({ workspaceId: workspace.id, tabId: hit.tabId, location: hit.location, snippet: hit.snippet, score: hit.score });
    }
  }
  return all.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 8);
}

function rank(hits: ProjectSearchHit[], limit: number): ProjectSearchHit[] {
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: ProjectSearchHit[] = [];
  for (const hit of hits) {
    const key = hit.type === "result" ? `r:${hit.id}` : `s:${hit.tabId}:${hit.location.kind}:${"page" in hit.location ? hit.location.page : ""}:${"line" in hit.location ? hit.location.line : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

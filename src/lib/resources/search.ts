import { formatTimestamp } from "./transcript";
import type { Tab } from "@/lib/tabs/types";
import type { ResourceContent } from "./types";

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
 * contents, and has no way to reach any other.
 */

export type SearchLocation =
  | { kind: "title" }
  | { kind: "address" }
  | { kind: "notes" }
  | { kind: "text" }
  | { kind: "page"; page: number }
  | { kind: "transcript"; start?: number };

export type ProjectSearchHit =
  | { type: "source"; tabId: string; location: SearchLocation; snippet: string; score: number }
  | { type: "result"; id: string; snippet: string; score: number };

export type SearchableResult = { id: string; text: string };

const MAX_HITS = 50;
const SNIPPET_RADIUS = 80;

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1))].slice(0, 8);
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  for (let index = haystack.indexOf(term); index !== -1; index = haystack.indexOf(term, index + term.length)) count += 1;
  return count;
}

function scoreOf(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const count = occurrences(lower, term);
    if (count === 0) return 0;
    score += count;
  }
  return score;
}

export function snippetAround(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
  if (!Number.isFinite(first)) return text.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(text.length, first + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** Where a hit is, in words: "page 4", "at 3:12". */
export function describeLocation(location: SearchLocation): string | undefined {
  if (location.kind === "page") return `page ${location.page}`;
  if (location.kind === "transcript") return location.start !== undefined ? `at ${formatTimestamp(location.start)}` : "transcript";
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
  const hits: ProjectSearchHit[] = [];
  const push = (tabId: string, location: SearchLocation, text: string, weight: number) => {
    const score = scoreOf(text, terms);
    if (score > 0) hits.push({ type: "source", tabId, location, snippet: snippetAround(text, terms), score: score * weight });
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
    // Transcript lines are short; search them in windows so a phrase split across two lines still matches.
    const lines = content.transcript ?? [];
    for (let index = 0; index < lines.length; index += 4) {
      const window = lines.slice(index, index + 6);
      // The time of the first line that mentions a term, so "at 1:05" is where it is said.
      const at = window.find((line) => terms.some((term) => line.text.toLowerCase().includes(term))) ?? window[0];
      push(tab.id, { kind: "transcript", ...(at?.start !== undefined ? { start: at.start } : {}) }, window.map((line) => line.text).join(" "), 1);
    }
  }
  for (const result of input.results ?? []) {
    const score = scoreOf(result.text, terms);
    if (score > 0) hits.push({ type: "result", id: result.id, snippet: snippetAround(result.text, terms), score: score * 3 });
  }

  // Strongest first; within a source, the strongest place only once per location kind+page.
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: ProjectSearchHit[] = [];
  for (const hit of hits) {
    const key = hit.type === "result" ? `r:${hit.id}` : `s:${hit.tabId}:${hit.location.kind}:${"page" in hit.location ? hit.location.page : ""}:${"start" in hit.location ? hit.location.start : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= (input.limit ?? MAX_HITS)) break;
  }
  return out;
}

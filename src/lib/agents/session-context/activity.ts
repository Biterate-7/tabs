import { isSessionContextTool } from "./capabilities";
import type { SessionContextTool } from "./capabilities";

/**
 * What a session's agent did with its Hubble context, as the context server
 * saw it — the source of "Read workspace · 18 tabs" and "Found 14 relevant
 * tabs" on the activity timeline.
 *
 * ## Why the server measures, and nothing else does
 *
 * The adapter sees a tool call leave and, for some providers, never sees it
 * come back; it never sees the answer. The server built the answer, so it is
 * the one place that can say how many tabs a search found for every provider
 * alike. It measures **its own** JSON, after the fact, and reports counts:
 * never a title, a URL, a tab id or the words the agent searched for.
 *
 * ## Why it is observational
 *
 * Measuring runs after the answer exists and cannot change it. Anything that
 * goes wrong here — an answer shape this module does not know, a listener
 * that throws — is swallowed by the caller: a timeline that is missing a row
 * is a small loss; an agent whose tool call failed because the timeline
 * could not count is not.
 */

export type ContextActivityCounts = {
  tabs?: number;
  collections?: number;
  matches?: number;
  groups?: number;
};

export type ContextActivity = ContextActivityCounts & {
  tool: SessionContextTool;
  /** Whether the server answered, rather than refused. */
  ok: boolean;
};

/**
 * The tools that propose a change. Not reads: a proposal is followed by an
 * approval, which the timeline already shows from the broker's own events,
 * and its tool call does not return until the person has answered.
 */
export const CONTEXT_WRITE_TOOLS: readonly SessionContextTool[] = [
  "create_collection",
  "rename_collection",
  "add_tabs_to_collection",
  "propose_workspace_plan",
] as const;

export function isContextReadTool(tool: string): tool is SessionContextTool {
  return isSessionContextTool(tool) && !CONTEXT_WRITE_TOOLS.includes(tool);
}

const MAX_COUNT = 1_000_000;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The counts an answer states, read off the shapes the session server writes (lib/mcp/server.ts). */
export function measureAnswerPayload(payload: unknown): ContextActivityCounts {
  const answer = record(payload);
  if (!answer) return {};
  const counts: ContextActivityCounts = {};

  // A resolved snapshot (get_tabs, list_tabs, get_workspace, …): what it holds.
  if (Array.isArray(answer.items)) {
    let tabs = 0;
    let collections = 0;
    for (const item of answer.items) {
      const type = record(item)?.sourceType;
      if (type === "tab") tabs++;
      else if (type === "collection") collections++;
    }
    counts.tabs = tabs;
    if (collections > 0) counts.collections = collections;
  }

  // The workspace summary: the whole workspace, in totals.
  const tabTotal = count(record(answer.tabs)?.total);
  if (tabTotal !== undefined) counts.tabs = tabTotal;
  const collectionTotal = count(record(answer.collections)?.total);
  if (collectionTotal !== undefined) counts.collections = collectionTotal;

  // A list of collections (list_collections, find_relevant_collections).
  if (Array.isArray(answer.collections)) counts.collections = answer.collections.length;

  // Topic analysis: how many tabs it considered.
  const considered = count(answer.tabsConsidered);
  if (considered !== undefined) counts.tabs = considered;

  // A search states its total; relatedness lists its matches.
  const totalMatches = count(answer.totalMatches);
  if (totalMatches !== undefined) counts.matches = totalMatches;
  else if (count(answer.matches) !== undefined) counts.matches = count(answer.matches);
  else if (Array.isArray(answer.matches)) counts.matches = answer.matches.length;

  // Topic and duplicate groups: the total when stated, else what was listed.
  const totalGroups = count(answer.totalGroups);
  if (totalGroups !== undefined) counts.groups = totalGroups;
  else if (Array.isArray(answer.groups)) counts.groups = answer.groups.length + (count(answer.moreGroups) ?? 0);

  return counts;
}

/**
 * Measures one answer from the session's context server, or `undefined` for a
 * tool that is not a read (see `CONTEXT_WRITE_TOOLS`) or a name Hubble does
 * not serve. Never throws.
 */
export function measureContextAnswer(
  tool: string,
  answer: { content?: readonly { type: string; text?: string }[]; isError?: boolean } | undefined
): ContextActivity | undefined {
  if (!isContextReadTool(tool)) return undefined;
  if (!answer || answer.isError) return { tool, ok: false };

  const text = answer.content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") return { tool, ok: true };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { tool, ok: true };
  }
  return { tool, ok: true, ...measureAnswerPayload(payload) };
}

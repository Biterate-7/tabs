import { knowledgeItemsOf } from "@/lib/memory/items";
import { itemActivityAt } from "@/lib/memory/kinds";
import { isLegacyProjectEvent } from "@/lib/projects/activity";
import type { KnowledgeItem } from "@/lib/memory/items";
import type { ProjectEvent } from "@/lib/projects/activity";
import type { LoopRecord } from "@/lib/product/loop-log";
import type { TabSession } from "@/lib/sessions/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Home's three questions — where was I, what changed, what next — answered
 * from records Hubble already keeps. Nothing here is estimated or invented:
 * "where you were" is the project something last happened in, "what
 * changed" is what arrived since the previous visit, and every suggestion
 * points at a real item.
 */

export type ProjectPulse = {
  workspace: Workspace;
  /** When anything last happened in it: an item, an event, a session saved for it. */
  lastAt: number;
  /** Its items, most recent first. */
  items: KnowledgeItem[];
  /** The most recent session saved for it. */
  session?: TabSession;
  /** The latest thing recorded in its history. */
  lastEvent?: ProjectEvent;
  /** Items that could not be read and are waiting on the person. */
  attention: KnowledgeItem[];
};

function itemAt(item: KnowledgeItem): number {
  return itemActivityAt(item);
}

function sessionAt(session: TabSession): number {
  return Math.max(session.updatedAt, session.lastRestoredAt ?? 0);
}

/** Every project with what is current in it, most recently active first. */
export function projectPulses(input: { workspaces: readonly Workspace[]; sessions: readonly TabSession[]; events: readonly ProjectEvent[] }): ProjectPulse[] {
  const eventsBy = new Map<string, ProjectEvent[]>();
  for (const event of input.events) {
    if (isLegacyProjectEvent(event)) continue;
    eventsBy.set(event.workspaceId, [...(eventsBy.get(event.workspaceId) ?? []), event]);
  }
  return input.workspaces
    .map((workspace): ProjectPulse => {
      const items = knowledgeItemsOf(workspace).sort((a, b) => itemAt(b) - itemAt(a));
      const sessions = input.sessions.filter((session) => session.workspaceId === workspace.id).sort((a, b) => sessionAt(b) - sessionAt(a));
      const events = (eventsBy.get(workspace.id) ?? []).sort((a, b) => b.at - a.at);
      // Only what the person did: Hubble reading a source in the background is not them working here.
      const personal = events.find((event) => event.kind !== "source_ready" && event.kind !== "source_failed");
      // Not workspace.updatedAt: a background re-read bumps it, and that is not the person working here.
      const lastAt = Math.max(workspace.createdAt, items[0] ? itemAt(items[0]) : 0, personal?.at ?? 0, sessions[0] ? sessionAt(sessions[0]) : 0);
      return {
        workspace,
        lastAt,
        items,
        ...(sessions[0] ? { session: sessions[0] } : {}),
        ...(events[0] ? { lastEvent: events[0] } : {}),
        attention: items.filter((item) => item.status === "failed"),
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** How long a gap between visits counts as having been away. */
export const AWAY_MS = 2 * 3600_000;

/**
 * When the person was last here before this visit: the previous recorded
 * return (loop-log `workspace_revisited`, written at most once per half hour
 * at launch), provided it was long enough ago to have been "away".
 */
export function previousVisit(records: readonly LoopRecord[], now: number): number | undefined {
  const visits = records.filter((record) => record.kind === "workspace_revisited" && record.at <= now).map((record) => record.at).sort((a, b) => b - a);
  // The newest is usually this visit itself; the one before it is where "since" starts.
  const candidate = visits.find((at) => now - at >= AWAY_MS);
  return candidate;
}

export type ChangeSummary = { since: number; items: { workspace: Workspace; item: KnowledgeItem }[] };

/** What arrived in any project since `since`, newest first. */
export function changesSince(pulses: readonly ProjectPulse[], since: number, limit = 6): ChangeSummary {
  const items: ChangeSummary["items"] = [];
  for (const pulse of pulses) for (const item of pulse.items) if (item.addedAt > since) items.push({ workspace: pulse.workspace, item });
  items.sort((a, b) => b.item.addedAt - a.item.addedAt);
  return { since, items: items.slice(0, limit) };
}

/** Recent things across every project — Home's "Recently saved" — newest first. */
export function recentItems(pulses: readonly ProjectPulse[], limit: number): { workspace: Workspace; item: KnowledgeItem }[] {
  const all: { workspace: Workspace; item: KnowledgeItem }[] = [];
  for (const pulse of pulses) for (const item of pulse.items) all.push({ workspace: pulse.workspace, item });
  return all.sort((a, b) => b.item.addedAt - a.item.addedAt).slice(0, limit);
}

/** The project's history across every project, newest first, for Home's activity column. */
export function recentEvents(events: readonly ProjectEvent[], workspaceIds: ReadonlySet<string>, limit: number): ProjectEvent[] {
  return events
    .filter((event) => !isLegacyProjectEvent(event) && workspaceIds.has(event.workspaceId))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** A greeting that knows the hour and nothing else. */
export function greetingFor(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

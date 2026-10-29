import { itemActivityAt, itemKind } from "@/lib/memory/kinds"
import { sourceKey } from "@/lib/resources/url"
import type { ItemKind } from "@/lib/memory/kinds"
import type { ProjectPulse } from "@/lib/product/continuity"
import type { Checkpoint, ContextState } from "./types"

/**
 * Smart Resume: when the person comes back, the project they were working
 * on — what it holds, what changed since they last picked it up, and the
 * session that reopens its tabs.
 *
 * Shown only when it is worth it: they have been away (a real gap, the same
 * one Home's "since you were last here" uses) or new pages that fit the
 * project are waiting; never twice in a row after "not now"; never right
 * after they resumed it.
 *
 * The summary is built from what the project holds — kinds, titles, dates
 * and whether Hubble has each item's text — and says so. It never claims
 * progress, conclusions or tasks; an "unresolved" line appears only for
 * something the data shows (a conversation saved as a link, a page Hubble
 * couldn't read).
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Projects untouched for longer are not "where you left off". */
export const RESUME_WINDOW_MS = 14 * DAY
/** "Not now" holds this long for the same project. */
export const RESUME_DISMISS_MS = 12 * HOUR
/** Just resumed: not offered again this soon. */
export const RESUME_COOLDOWN_MS = 2 * HOUR

export type ProjectSummary = {
  counts: Record<ItemKind, number>
  /** The most recent items, newest first. */
  latest: { title: string; kind: ItemKind; at: number }[]
  /** Conversations saved without their text. */
  linkOnlyConversations: number
  /** Sources Hubble could not read. */
  unreadable: number
  /** The person's own one-line focus for the project, when they wrote one. */
  focus?: string
  /** Always "metadata": built from kinds, titles and dates, not by reading or summarising content. */
  basis: "metadata"
}

export type ResumeRecommendation = {
  workspaceId: string
  lastAt: number
  summary: ProjectSummary
  /** The session saved for this project, when there is one. */
  sessionId?: string
  /** Items in the project now that weren't at the last checkpoint. */
  newSinceCheckpoint: number
  checkpointAt?: number
  /** Open suggestions to add pages to this project. */
  waiting: number
  reason: "returning" | "new-related"
}

export function summarizeProject(pulse: ProjectPulse): ProjectSummary {
  const counts: Record<ItemKind, number> = { conversation: 0, source: 0, file: 0, note: 0 }
  let linkOnlyConversations = 0
  let unreadable = 0
  for (const item of pulse.items) {
    const kind = itemKind(item)
    counts[kind] += 1
    if (item.type === "conversation" && !item.hasText) linkOnlyConversations += 1
    // Home's own rule for "Needs attention": only what Hubble tried and failed to read.
    else if (item.ref.kind === "source" && item.status === "failed") unreadable += 1
  }
  const focus = pulse.workspace.brief?.focus?.trim() || pulse.workspace.brief?.description?.trim()
  return {
    counts,
    latest: pulse.items.slice(0, 3).map((item) => ({ title: item.title, kind: itemKind(item), at: itemActivityAt(item) })),
    linkOnlyConversations,
    unreadable,
    ...(focus ? { focus: focus.slice(0, 200) } : {}),
    basis: "metadata",
  }
}

/** A checkpoint of the project as it is now: what "new since you picked this up" is measured against. */
export function makeCheckpoint(pulse: ProjectPulse, now: number): Checkpoint {
  const keys = pulse.workspace.tabs.map((tab) => sourceKey(tab.url)).filter((key): key is string => key !== undefined)
  return { workspaceId: pulse.workspace.id, at: now, itemCount: pulse.items.length, keys: [...new Set(keys)].slice(0, 500) }
}

export function upsertCheckpoint(state: ContextState, checkpoint: Checkpoint): ContextState {
  return { ...state, checkpoints: [...state.checkpoints.filter((entry) => entry.workspaceId !== checkpoint.workspaceId), checkpoint].slice(-200) }
}

/**
 * The project to offer, or undefined. `returningFrom` is when the person was
 * last here before this visit (continuity.ts `previousVisit`), when they
 * have been away.
 */
export function recommendResume(input: {
  pulses: readonly ProjectPulse[]
  state: Pick<ContextState, "checkpoints" | "resume" | "suggestions">
  now: number
  returningFrom?: number
}): ResumeRecommendation | undefined {
  const { pulses, state, now } = input
  const lead = pulses.find((pulse) => pulse.items.length > 0)
  if (!lead || now - lead.lastAt > RESUME_WINDOW_MS) return undefined
  const workspaceId = lead.workspace.id
  const dismissed = state.resume.dismissed
  if (dismissed && dismissed.workspaceId === workspaceId && now - dismissed.at < RESUME_DISMISS_MS) return undefined
  const checkpoint = state.checkpoints.find((entry) => entry.workspaceId === workspaceId)
  if (checkpoint && now - checkpoint.at < RESUME_COOLDOWN_MS) return undefined

  const waiting = state.suggestions.filter((suggestion) => suggestion.status === "open" && suggestion.destination.kind === "project" && suggestion.destination.workspaceId === workspaceId).length
  const returning = input.returningFrom !== undefined && lead.lastAt <= now
  if (!returning && waiting === 0) return undefined

  const known = new Set(checkpoint?.keys ?? [])
  // Pages not in the checkpoint, or more items than it had (notes have no address): whichever says more.
  const newPages = checkpoint ? new Set(lead.workspace.tabs.map((tab) => sourceKey(tab.url)).filter((key): key is string => key !== undefined && !known.has(key))).size : 0
  const newSinceCheckpoint = checkpoint ? Math.max(newPages, lead.items.length - checkpoint.itemCount) : 0
  return {
    workspaceId,
    lastAt: lead.lastAt,
    summary: summarizeProject(lead),
    ...(lead.session ? { sessionId: lead.session.id } : {}),
    newSinceCheckpoint,
    ...(checkpoint ? { checkpointAt: checkpoint.at } : {}),
    waiting,
    reason: returning ? "returning" : "new-related",
  }
}

export function dismissResume(state: ContextState, workspaceId: string, now: number): ContextState {
  return { ...state, resume: { dismissed: { workspaceId, at: now } } }
}

/** The summary in a few short lines — counts, the latest item, and only gaps the data shows. */
export function describeSummary(summary: ProjectSummary): { counts: string; gaps: string[] } {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const { conversation, source, file, note } = summary.counts
  const counts = [
    conversation > 0 ? plural(conversation, "AI conversation", "AI conversations") : "",
    source > 0 ? plural(source, "source", "sources") : "",
    file > 0 ? plural(file, "file", "files") : "",
    note > 0 ? plural(note, "note", "notes") : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const gaps = [
    summary.linkOnlyConversations > 0
      ? `${plural(summary.linkOnlyConversations, "conversation is", "conversations are")} saved as a link only — save ${summary.linkOnlyConversations === 1 ? "it" : "them"} from the page to keep the text`
      : "",
    summary.unreadable > 0 ? `${plural(summary.unreadable, "source", "sources")} couldn't be read` : "",
  ].filter(Boolean)
  return { counts, gaps }
}

import { recordFeatures } from "./features"
import { DEFAULT_CONFIG } from "./scoring"
import { REJECT_ANY, REJECT_NEW_PROJECT } from "./types"
import type { InferenceConfig } from "./scoring"
import type { ActivityRecord, Association, ContextState, Rejection, Suggestion } from "./types"

/**
 * What the person decided, as pure changes to the context state. Their
 * decisions are kept apart from anything inferred: an association they
 * confirmed is never overridden by a later run, and a rejection keeps the
 * same suggestion from coming back.
 */

const DAY = 24 * 60 * 60 * 1000
const MAX_FEEDBACK = 2000
const REJECTION_TERMS = 12

export type DismissReason =
  /** Ask again in a few days. */
  | "not-now"
  /** These pages aren't part of the person's work: never suggested again. */
  | "not-relevant"
  /** Not this project (save-to-project only): these pages may still fit another. */
  | "wrong-project"

/** The words kept with a rejection: enough to recognise a similar page, not the page. */
function rejectionTerms(record: ActivityRecord | undefined): string[] | undefined {
  if (!record) return undefined
  const terms = [...recordFeatures(record).terms.entries()]
    .filter(([term]) => !term.startsWith("site:"))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, REJECTION_TERMS)
    .map(([term]) => term)
  return terms.length > 0 ? terms : undefined
}

function addRejections(existing: readonly Rejection[], keys: readonly string[], target: string, records: ReadonlyMap<string, ActivityRecord>, now: number): Rejection[] {
  const kept = existing.filter((rejection) => !(keys.includes(rejection.key) && rejection.target === target))
  const added = keys.map((key) => {
    const terms = rejectionTerms(records.get(key))
    return { key, target, at: now, ...(terms ? { terms } : {}) }
  })
  return [...kept, ...added].slice(-MAX_FEEDBACK)
}

function targetOf(suggestion: Suggestion): string {
  return suggestion.destination.kind === "project" ? suggestion.destination.workspaceId : REJECT_NEW_PROJECT
}

function replace(state: ContextState, next: Suggestion): Suggestion[] {
  return state.suggestions.map((suggestion) => (suggestion.id === next.id ? next : suggestion))
}

export type Acceptance = {
  /** The pages the person kept in the review (they may have taken some out). */
  recordKeys: readonly string[]
  /** Where they put them — the suggested project, another one, or a project just created. */
  workspaceId: string
  now: number
}

/**
 * The person confirmed a suggestion. Each kept page is now associated with
 * the project it went to — confirmed, not inferred. A page they took out of
 * the review is a correction (not this project); choosing a different
 * project than the one suggested is a correction of the suggested one.
 */
export function acceptSuggestion(state: ContextState, id: string, acceptance: Acceptance): ContextState {
  const suggestion = state.suggestions.find((entry) => entry.id === id)
  if (!suggestion || (suggestion.status !== "open" && suggestion.status !== "snoozed")) return state
  const kept = acceptance.recordKeys.filter((key) => suggestion.recordKeys.includes(key))
  const removed = suggestion.recordKeys.filter((key) => !kept.includes(key))
  const records = new Map(state.records.map((record) => [record.key, record]))
  let rejections = removed.length > 0 ? addRejections(state.rejections, removed, targetOf(suggestion), records, acceptance.now) : state.rejections
  const moved = suggestion.destination.kind === "project" && suggestion.destination.workspaceId !== acceptance.workspaceId
  if (moved) rejections = addRejections(rejections, kept, targetOf(suggestion), records, acceptance.now)
  const by: Association["by"] = moved ? "moved" : "accepted"
  const associations = [
    ...state.associations.filter((association) => !kept.includes(association.key)),
    ...kept.map((key) => ({ key, workspaceId: acceptance.workspaceId, at: acceptance.now, by })),
  ].slice(-MAX_FEEDBACK)
  return {
    ...state,
    associations,
    rejections,
    suggestions: replace(state, { ...suggestion, status: "accepted", decidedAt: acceptance.now, recordKeys: [...kept] }),
  }
}

export function dismissSuggestion(state: ContextState, id: string, reason: DismissReason, now: number, config: InferenceConfig = DEFAULT_CONFIG): ContextState {
  const suggestion = state.suggestions.find((entry) => entry.id === id)
  if (!suggestion || (suggestion.status !== "open" && suggestion.status !== "snoozed")) return state
  if (reason === "not-now") {
    return { ...state, suggestions: replace(state, { ...suggestion, status: "snoozed", snoozedUntil: now + config.snoozeDays * DAY, decidedAt: now }) }
  }
  const records = new Map(state.records.map((record) => [record.key, record]))
  const target = reason === "not-relevant" ? REJECT_ANY : targetOf(suggestion)
  return {
    ...state,
    rejections: addRejections(state.rejections, suggestion.recordKeys, target, records, now),
    suggestions: replace(state, { ...suggestion, status: "dismissed", decidedAt: now }),
  }
}

/**
 * Undo of an acceptance: the associations it made go, and the suggestion is
 * put away for the snooze period rather than offered again at once.
 */
export function undoAcceptance(state: ContextState, id: string, now: number, config: InferenceConfig = DEFAULT_CONFIG): ContextState {
  const suggestion = state.suggestions.find((entry) => entry.id === id)
  if (!suggestion || suggestion.status !== "accepted") return state
  const decidedAt = suggestion.decidedAt ?? 0
  return {
    ...state,
    associations: state.associations.filter((association) => !(suggestion.recordKeys.includes(association.key) && association.at === decidedAt)),
    suggestions: replace(state, { ...suggestion, status: "snoozed", snoozedUntil: now + config.snoozeDays * DAY, decidedAt: now }),
  }
}

/** Marks suggestions as shown: a suggestion is announced once, however many surfaces show it. */
export function markSurfaced(state: ContextState, ids: readonly string[], now: number): ContextState {
  let changed = false
  const suggestions = state.suggestions.map((suggestion) => {
    if (!ids.includes(suggestion.id) || suggestion.surfacedAt) return suggestion
    changed = true
    return { ...suggestion, surfacedAt: now }
  })
  return changed ? { ...state, suggestions } : state
}

/**
 * The person removed pages from Hubble's activity: their records, every
 * suggestion's mention of them, and the feedback that names them go. Nothing
 * in any project is touched — a page already saved stays saved.
 */
export function forgetRecords(state: ContextState, keys: readonly string[], now: number): ContextState {
  if (keys.length === 0) return state
  const gone = new Set(keys)
  const suggestions = state.suggestions
    .map((suggestion) => {
      if (!suggestion.recordKeys.some((key) => gone.has(key))) return suggestion
      const recordKeys = suggestion.recordKeys.filter((key) => !gone.has(key))
      const empty = recordKeys.length === 0 || (suggestion.kind === "create-project" && recordKeys.length < 2)
      if (empty) return suggestion.status === "open" ? { ...suggestion, recordKeys, status: "expired" as const, decidedAt: now } : { ...suggestion, recordKeys }
      return { ...suggestion, recordKeys, updatedAt: now }
    })
    .filter((suggestion) => suggestion.recordKeys.length > 0)
  return {
    ...state,
    records: state.records.filter((record) => !gone.has(record.key)),
    suggestions,
    associations: state.associations.filter((association) => !gone.has(association.key)),
    rejections: state.rejections.filter((rejection) => !gone.has(rejection.key)),
    checkpoints: state.checkpoints.map((checkpoint) => ({ ...checkpoint, keys: checkpoint.keys.filter((key) => !gone.has(key)) })),
  }
}

import { mergeRecords, MAX_RECORDS, readActivityRecord } from "./records"
import { CONTEXT_SCHEMA_VERSION } from "./types"
import type { Association, Checkpoint, ContextState, Evidence, Rejection, Suggestion, SuggestionDestination, SuggestionPreference } from "./types"

/**
 * The stored context state, re-read: storage is untrusted (an older build, a
 * hand edit, another extension). Anything malformed is dropped, never
 * guessed at; a record is re-checked by the same rules as one arriving from
 * the extension.
 */

const MAX_SUGGESTIONS = 100
const MAX_FEEDBACK = 2000
const MAX_CHECKPOINTS = 200
const ID = /^[A-Za-z0-9_-]{1,100}$/

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const strings = (value: unknown, max: number, each = 2000): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => text(entry, each)).slice(0, max) : [])
const score = (value: unknown) => (finite(value) ? Math.min(1, value) : 0)

export function emptyContextState(): ContextState {
  return { version: CONTEXT_SCHEMA_VERSION, records: [], associations: [], rejections: [], suggestions: [], checkpoints: [], resume: {}, preference: "all" }
}

function readEvidence(value: unknown): Evidence {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  return {
    sharedTerms: strings(raw.sharedTerms, 8, 60),
    nameTerms: strings(raw.nameTerms, 8, 60),
    days: Number.isInteger(raw.days) && (raw.days as number) >= 0 ? Math.min(raw.days as number, 366) : 0,
    fromContent: raw.fromContent === true,
    semantic: score(raw.semantic),
    temporal: score(raw.temporal),
    feedbackPenalty: score(raw.feedbackPenalty),
  }
}

function readDestination(value: unknown): SuggestionDestination | undefined {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  if (raw.kind === "project" && text(raw.workspaceId, 200)) return { kind: "project", workspaceId: raw.workspaceId }
  if (raw.kind === "new-project" && text(raw.name, 120)) return { kind: "new-project", name: raw.name }
  return undefined
}

function readSuggestion(value: unknown): Suggestion | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const destination = readDestination(raw.destination)
  if (!text(raw.id, 100) || !ID.test(raw.id) || !text(raw.dedupeKey, 2100) || !destination) return undefined
  if (raw.kind !== "save-to-project" && raw.kind !== "create-project") return undefined
  if ((raw.kind === "save-to-project") !== (destination.kind === "project")) return undefined
  if (!["open", "accepted", "dismissed", "snoozed", "expired"].includes(raw.status as string)) return undefined
  if (!finite(raw.createdAt) || !finite(raw.updatedAt) || !finite(raw.expiresAt)) return undefined
  const recordKeys = [...new Set(strings(raw.recordKeys, 50))]
  if (recordKeys.length === 0) return undefined
  return {
    id: raw.id,
    dedupeKey: raw.dedupeKey,
    kind: raw.kind,
    recordKeys,
    destination,
    alternatives: strings(raw.alternatives, 4, 200),
    confidence: score(raw.confidence),
    band: raw.band === "strong" ? "strong" : "review",
    evidence: readEvidence(raw.evidence),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    expiresAt: raw.expiresAt,
    status: raw.status as Suggestion["status"],
    ...(finite(raw.snoozedUntil) ? { snoozedUntil: raw.snoozedUntil } : {}),
    ...(finite(raw.decidedAt) ? { decidedAt: raw.decidedAt } : {}),
    ...(finite(raw.surfacedAt) ? { surfacedAt: raw.surfacedAt } : {}),
  }
}

function readAssociation(value: unknown): Association | undefined {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  if (!text(raw.key, 2100) || !text(raw.workspaceId, 200) || !finite(raw.at)) return undefined
  return { key: raw.key, workspaceId: raw.workspaceId, at: raw.at, by: raw.by === "moved" ? "moved" : "accepted" }
}

function readRejection(value: unknown): Rejection | undefined {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  if (!text(raw.key, 2100) || !text(raw.target, 200) || !finite(raw.at)) return undefined
  const terms = strings(raw.terms, 12, 40)
  return { key: raw.key, target: raw.target, at: raw.at, ...(terms.length > 0 ? { terms } : {}) }
}

function readCheckpoint(value: unknown): Checkpoint | undefined {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  if (!text(raw.workspaceId, 200) || !finite(raw.at)) return undefined
  return { workspaceId: raw.workspaceId, at: raw.at, itemCount: Number.isInteger(raw.itemCount) ? Math.max(0, raw.itemCount as number) : 0, keys: strings(raw.keys, 500, 2100) }
}

function readPreference(value: unknown): SuggestionPreference {
  return value === "strong" || value === "off" ? value : "all"
}

export function readContextState(value: unknown): ContextState {
  if (!value || typeof value !== "object") return emptyContextState()
  const raw = value as Record<string, unknown>
  const byKey = new Map<string, NonNullable<ReturnType<typeof readActivityRecord>>>()
  for (const entry of Array.isArray(raw.records) ? raw.records : []) {
    const record = readActivityRecord(entry)
    if (!record) continue
    const existing = byKey.get(record.key)
    byKey.set(record.key, existing ? mergeRecords(existing, record) : record)
  }
  const records = [...byKey.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_RECORDS)
  const cursorRaw = (raw.cursor && typeof raw.cursor === "object" ? raw.cursor : {}) as Record<string, unknown>
  const cursor = text(cursorRaw.epoch, 200) && Number.isInteger(cursorRaw.seq) && (cursorRaw.seq as number) >= 0 ? { epoch: cursorRaw.epoch, seq: cursorRaw.seq as number } : undefined
  const seen = new Set<string>()
  const suggestions: Suggestion[] = []
  for (const entry of Array.isArray(raw.suggestions) ? raw.suggestions : []) {
    const suggestion = readSuggestion(entry)
    if (!suggestion || seen.has(suggestion.id)) continue
    seen.add(suggestion.id)
    suggestions.push(suggestion)
    if (suggestions.length >= MAX_SUGGESTIONS) break
  }
  const list = <T>(value: unknown, read: (entry: unknown) => T | undefined, max: number): T[] =>
    (Array.isArray(value) ? value : []).map(read).filter((entry): entry is T => entry !== undefined).slice(-max)
  const resumeRaw = (raw.resume && typeof raw.resume === "object" ? raw.resume : {}) as Record<string, unknown>
  const dismissedRaw = (resumeRaw.dismissed && typeof resumeRaw.dismissed === "object" ? resumeRaw.dismissed : {}) as Record<string, unknown>
  const dismissed = text(dismissedRaw.workspaceId, 200) && finite(dismissedRaw.at) ? { workspaceId: dismissedRaw.workspaceId, at: dismissedRaw.at } : undefined
  return {
    version: CONTEXT_SCHEMA_VERSION,
    records,
    ...(cursor ? { cursor } : {}),
    associations: list(raw.associations, readAssociation, MAX_FEEDBACK),
    rejections: list(raw.rejections, readRejection, MAX_FEEDBACK),
    suggestions,
    checkpoints: list(raw.checkpoints, readCheckpoint, MAX_CHECKPOINTS),
    resume: dismissed ? { dismissed } : {},
    preference: readPreference(raw.preference),
    ...(finite(raw.onboardingDeferredAt) ? { onboardingDeferredAt: raw.onboardingDeferredAt } : {}),
  }
}

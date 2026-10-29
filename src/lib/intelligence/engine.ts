import { clusterPages } from "./cluster"
import { nameFromWords } from "./explain"
import { inverseFrequencies, projectFeatures, recordFeatures } from "./features"
import { rankProjects } from "./match"
import { upsertRecords } from "./records"
import { bandOf, clamp01, DEFAULT_CONFIG } from "./scoring"
import { createLocalSimilarity } from "./similarity"
import { spanDays } from "./temporal"
import { REJECT_ANY, REJECT_NEW_PROJECT } from "./types"
import type { ProjectFeatures, RecordFeatures } from "./features"
import type { ProjectScore } from "./match"
import type { InferenceConfig } from "./scoring"
import type { SimilarityProvider } from "./similarity"
import type { ActivityRecord, ContextState, Evidence, Suggestion, SuggestionPreference } from "./types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * One inference run: the person's pages and projects in, the suggestions to
 * show out. Pure — no clock it wasn't given, no storage — and incremental
 * where it matters: a run over unchanged input returns the same suggestions
 * (same ids, same objects), so nothing is announced twice.
 *
 *   1. Tidy what exists: expire stale suggestions, end snoozes, drop
 *      suggestions for deleted projects.
 *   2. Eligible pages: recent, really used (not a two-second glance), not
 *      already in a project, not something the person confirmed, rejected
 *      for everything, or snoozed.
 *   3. Existing projects first (match.ts). A page that fits one well enough
 *      is suggested for it — never for a new project.
 *   4. What no project covers is grouped (cluster.ts); a coherent group of
 *      enough pages is suggested as a new project.
 *   5. Suggestions are kept stable: one per project (new pages join it), a
 *      new-project suggestion is the same suggestion while most of its
 *      pages are, and a page is in at most one open suggestion.
 */

export type InferenceInput = {
  state: Pick<ContextState, "records" | "associations" | "rejections" | "suggestions">
  workspaces: readonly Workspace[]
  /** When each project was last worked on (its history or its last change). */
  projectLastAt?: ReadonlyMap<string, number>
  now: number
  preference?: SuggestionPreference
  config?: InferenceConfig
  /** Replaces the local topic-word similarity. */
  similarity?: (idf: ReadonlyMap<string, number>) => SimilarityProvider
  mintId: () => string
}

export type InferenceResult = {
  suggestions: Suggestion[]
  changed: boolean
  /** Each eligible page's best projects — for surfaces that explain a single page. */
  matches: Map<string, ProjectScore[]>
}

const DAY = 24 * 60 * 60 * 1000
const KEEP_DECIDED_MS = 30 * DAY
/** How much a provisionally matched page counts towards its project (a confirmed one counts 1). */
const PROVISIONAL_WEIGHT = 0.6

type Candidate = Omit<Suggestion, "id" | "createdAt" | "updatedAt" | "expiresAt" | "status">

function isEngaged(record: ActivityRecord, config: InferenceConfig): boolean {
  return (
    record.dwellMs >= config.minDwellMs ||
    record.visits >= 2 ||
    record.days.length >= 2 ||
    record.capture.status === "content" ||
    record.capture.status === "partial"
  )
}

function spell(term: string, sources: readonly (ReadonlyMap<string, string> | undefined)[]): string {
  for (const source of sources) {
    const spelled = source?.get(term)
    if (spelled) return spelled
  }
  return term
}

/** Words ranked by how many of the pages share them, then by first appearance. */
function rankWords(lists: readonly string[][]): string[] {
  const count = new Map<string, number>()
  const first = new Map<string, number>()
  let order = 0
  for (const list of lists) {
    for (const word of list) {
      count.set(word, (count.get(word) ?? 0) + 1)
      if (!first.has(word)) first.set(word, order++)
    }
  }
  return [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || first.get(a)! - first.get(b)!)
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((key) => set.has(key))
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const set = new Set(a)
  const shared = b.filter((key) => set.has(key)).length
  return shared / Math.min(a.length, b.length)
}

function sameEvidence(a: Evidence, b: Evidence): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Step 1. */
export function tidySuggestions(suggestions: readonly Suggestion[], input: { now: number; projectIds: ReadonlySet<string> }): Suggestion[] {
  const { now, projectIds } = input
  const out: Suggestion[] = []
  for (const suggestion of suggestions) {
    if (suggestion.status !== "open" && suggestion.status !== "snoozed" && (suggestion.decidedAt ?? suggestion.updatedAt) < now - KEEP_DECIDED_MS) continue
    const gone = suggestion.destination.kind === "project" && !projectIds.has(suggestion.destination.workspaceId)
    if (suggestion.status === "open" && (suggestion.expiresAt <= now || gone)) {
      out.push({ ...suggestion, status: "expired", decidedAt: now })
      continue
    }
    if (suggestion.status === "snoozed" && gone) {
      out.push({ ...suggestion, status: "expired", decidedAt: now })
      continue
    }
    out.push(suggestion)
  }
  return out
}

export function runInference(input: InferenceInput): InferenceResult {
  const config = input.config ?? DEFAULT_CONFIG
  const { now, workspaces, state } = input
  const preference = input.preference ?? "all"
  const projectIds = new Set(workspaces.map((workspace) => workspace.id))
  const before = state.suggestions
  const tidied = tidySuggestions(before, { now, projectIds })
  const matches = new Map<string, ProjectScore[]>()

  if (preference === "off") {
    // Asked not to suggest: nothing new, and what was waiting is put away rather than shown.
    const quiet = tidied.map((suggestion) => (suggestion.status === "open" ? { ...suggestion, status: "expired" as const, decidedAt: now } : suggestion))
    return { suggestions: quiet, changed: JSON.stringify(quiet) !== JSON.stringify(before), matches }
  }

  // Step 2.
  const associated = new Set(state.associations.map((association) => association.key))
  const rejectedEverywhere = new Set(state.rejections.filter((rejection) => rejection.target === REJECT_ANY).map((rejection) => rejection.key))
  const rejectedAsNew = new Set(state.rejections.filter((rejection) => rejection.target === REJECT_NEW_PROJECT).map((rejection) => rejection.key))
  const snoozed = new Set(tidied.filter((suggestion) => suggestion.status === "snoozed" && (suggestion.snoozedUntil ?? 0) > now).flatMap((suggestion) => suggestion.recordKeys))

  // One record per page, even if a caller hands over two (the extension's identity is coarser than Hubble's).
  const records = upsertRecords([], state.records, Number.MAX_SAFE_INTEGER)
  const byKey = new Map(records.map((record) => [record.key, record]))
  const featuresByKey = new Map<string, RecordFeatures>()
  const featuresOf = (record: ActivityRecord) => {
    let features = featuresByKey.get(record.key)
    if (!features) {
      features = recordFeatures(record)
      featuresByKey.set(record.key, features)
    }
    return features
  }

  const confirmedFor = new Map<string, RecordFeatures[]>()
  for (const association of state.associations) {
    const record = byKey.get(association.key)
    if (!record) continue
    const list = confirmedFor.get(association.workspaceId) ?? []
    list.push(featuresOf(record))
    confirmedFor.set(association.workspaceId, list)
  }
  const projects: ProjectFeatures[] = workspaces.map((workspace) => projectFeatures(workspace, confirmedFor.get(workspace.id) ?? []))
  const saved = new Set(projects.flatMap((project) => [...project.keys]))

  const eligible = records.filter(
    (record) =>
      record.lastSeenAt >= now - config.windowDays * DAY &&
      !associated.has(record.key) &&
      !saved.has(record.key) &&
      !rejectedEverywhere.has(record.key) &&
      !snoozed.has(record.key) &&
      isEngaged(record, config) &&
      [...featuresOf(record).terms.keys()].some((term) => !term.startsWith("site:"))
  )
  const eligibleKeys = new Set(eligible.map((record) => record.key))

  const idf = inverseFrequencies([...eligible.map((record) => featuresOf(record).terms), ...projects.map((project) => project.terms)])
  const similarity = (input.similarity ?? createLocalSimilarity)(idf)
  const lastAt = input.projectLastAt ?? new Map(workspaces.map((workspace) => [workspace.id, workspace.updatedAt]))
  const projectById = new Map(projects.map((project) => [project.workspaceId, project]))
  const threshold = preference === "strong" ? config.strong : config.review

  // Step 3, first pass: every page against every project.
  type Placed = { record: ActivityRecord; score: ProjectScore; alternatives: string[] }
  const placed = new Map<string, Placed[]>()
  const place = (record: ActivityRecord, ranked: ProjectScore[]) => {
    const best = ranked[0]
    if (!best || best.score < threshold) return false
    const alternatives = ranked.slice(1).filter((entry) => entry.score >= config.review && best.score - entry.score <= config.ambiguityMargin).map((entry) => entry.workspaceId)
    const list = placed.get(best.workspaceId) ?? []
    list.push({ record, score: best, alternatives })
    placed.set(best.workspaceId, list)
    return true
  }
  let pending: ActivityRecord[] = []
  for (const record of eligible) {
    const ranked = rankProjects({ record, page: featuresOf(record), projects, lastAt, similarity, rejections: state.rejections, config })
    matches.set(record.key, ranked)
    if (!place(record, ranked)) pending.push(record)
  }

  // Second pass: a page strongly matched to a project is provisional evidence for it — an article about
  // the same thing as a conversation about to be suggested for Economics IA fits Economics IA too. One
  // pass only, from strong matches only, at reduced weight, so nothing chains.
  const provisional = new Map<string, RecordFeatures[]>()
  for (const [workspaceId, entries] of placed) {
    const strong = entries.filter((entry) => entry.score.score >= config.strong).map((entry) => featuresOf(entry.record))
    if (strong.length > 0) provisional.set(workspaceId, strong)
  }
  const widened = projects.map((project) => withProvisional(project, provisional.get(project.workspaceId)))
  if (provisional.size > 0) {
    const still: ActivityRecord[] = []
    for (const record of pending) {
      const ranked = rankProjects({ record, page: featuresOf(record), projects: widened, lastAt, similarity, rejections: state.rejections, config })
      if (ranked.length > 0) matches.set(record.key, ranked)
      if (!place(record, ranked)) still.push(record)
    }
    pending = still
  }
  const unplaced = pending.filter((record) => !rejectedAsNew.has(record.key))
  const widenedById = new Map(widened.map((project) => [project.workspaceId, project]))

  // Step 4: what no project covers, grouped. A group that, taken together, fits an existing project goes
  // there — a new project is suggested only for a distinct body of work.
  const pageFeatures = unplaced.map(featuresOf)
  type NewGroup = { members: ActivityRecord[]; cohesion: number; temporal: number; sharedTerms: string[]; alternatives: string[] }
  const groups: NewGroup[] = []
  for (const cluster of clusterPages(unplaced, pageFeatures, similarity, config)) {
    const size = cluster.members.length
    const members = cluster.members.map((index) => unplaced[index]!)
    const coherent = cluster.sharedTerms.length > 0 && (size >= config.minClusterSize ? cluster.cohesion >= config.clusterMerge : cluster.cohesion >= config.pairClusterScore && members.some((record) => featuresOf(record).fromContent))
    if (!coherent) continue
    const together = groupFeatures(members.map(featuresOf))
    const fits = widened
      .map((project) => ({ project, match: similarity.coverage(together, project) }))
      .filter(({ project, match }) => match.score > 0 && !members.every((record) => state.rejections.some((rejection) => rejection.key === record.key && rejection.target === project.workspaceId)))
      .sort((a, b) => b.match.score - a.match.score)
    const best = fits[0]
    if (best && best.match.score >= config.review) {
      for (const record of members) {
        const own = (matches.get(record.key) ?? []).find((entry) => entry.workspaceId === best.project.workspaceId)
        const score: ProjectScore = {
          workspaceId: best.project.workspaceId,
          score: Math.max(own?.score ?? 0, best.match.score),
          semantic: Math.max(own?.semantic ?? 0, best.match.score),
          temporal: own?.temporal ?? 0,
          feedbackPenalty: own?.feedbackPenalty ?? 0,
          shared: own?.shared.length ? own.shared : best.match.shared,
          nameHits: own?.nameHits ?? [],
        }
        const list = placed.get(best.project.workspaceId) ?? []
        list.push({ record, score, alternatives: [] })
        placed.set(best.project.workspaceId, list)
      }
      continue
    }
    // Shares its leading words with a project, without covering enough to be placed there: offered as the other choice.
    const lead = new Set(cluster.sharedTerms.slice(0, 2))
    const alternatives = fits
      .filter(({ match }) => match.score >= 0.1 && match.shared.some((term) => lead.has(term)))
      .slice(0, 2)
      .map(({ project }) => project.workspaceId)
    groups.push({ members, cohesion: cluster.cohesion, temporal: cluster.temporal, sharedTerms: cluster.sharedTerms, alternatives })
  }

  const candidates: Candidate[] = []
  for (const [workspaceId, entries] of placed) {
    const project = widenedById.get(workspaceId) ?? projectById.get(workspaceId)!
    entries.sort((a, b) => b.score.score - a.score.score || b.record.lastSeenAt - a.record.lastSeenAt)
    const kept = entries.slice(0, config.maxPagesPerSuggestion)
    const top = kept.slice(0, 3)
    const confidence = clamp01(top.reduce((sum, entry) => sum + entry.score.score, 0) / top.length)
    const band = bandOf(confidence, config)
    if (band === "insufficient") continue
    const records = kept.map((entry) => entry.record)
    const spellings = [...records.map((record) => featuresOf(record).spelling), project.spelling]
    const shared = rankWords(kept.map((entry) => entry.score.shared)).slice(0, 5)
    const nameTerms = rankWords(kept.map((entry) => entry.score.nameHits))
    candidates.push({
      dedupeKey: `save:${workspaceId}`,
      kind: "save-to-project",
      recordKeys: records.map((record) => record.key),
      destination: { kind: "project", workspaceId },
      alternatives: rankWords(kept.map((entry) => entry.alternatives)).slice(0, 2),
      confidence,
      band,
      evidence: {
        sharedTerms: shared.map((term) => spell(term, spellings)),
        nameTerms: nameTerms.map((term) => spell(term, [project.spelling])),
        days: spanDays(records),
        fromContent: kept.some((entry) => featuresOf(entry.record).fromContent && entry.score.shared.some((term) => !featureTitleHas(entry.record, term, featuresOf))),
        semantic: clamp01(kept.reduce((sum, entry) => sum + entry.score.semantic, 0) / kept.length),
        temporal: clamp01(kept.reduce((sum, entry) => sum + entry.score.temporal, 0) / kept.length),
        feedbackPenalty: Math.max(...kept.map((entry) => entry.score.feedbackPenalty)),
      },
    })
  }

  for (const group of groups) {
    const size = group.members.length
    const confidence = clamp01(Math.min(1, group.cohesion * 2) * Math.min(1, 0.55 + 0.12 * size))
    const band = bandOf(confidence, config)
    if (band === "insufficient" || (preference === "strong" && band !== "strong")) continue
    const kept = [...group.members].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, config.maxPagesPerSuggestion)
    const spellings = kept.map((record) => featuresOf(record).spelling)
    const words = group.sharedTerms.slice(0, 5).map((term) => spell(term, spellings))
    // The two leading words in the order a title says them ("Chain rule", "Sugar tax"), from the three most shared.
    const name = nameFromWords(inTitleOrder(group.sharedTerms.slice(0, 3), kept.map(featuresOf)).slice(0, 2).map((term) => spell(term, spellings)))
    candidates.push({
      dedupeKey: `new:${[...kept.map((record) => record.key)].sort()[0]}`,
      kind: "create-project",
      recordKeys: kept.map((record) => record.key),
      destination: { kind: "new-project", name },
      alternatives: group.alternatives,
      confidence,
      band,
      evidence: {
        sharedTerms: words,
        nameTerms: [],
        days: spanDays(kept),
        fromContent: kept.some((record) => featuresOf(record).fromContent),
        semantic: clamp01(group.cohesion),
        temporal: clamp01(group.temporal),
        feedbackPenalty: 0,
      },
    })
  }

  // Step 5.
  const next: Suggestion[] = []
  const claimed = new Set<string>()
  const used = new Set<string>()
  candidates.sort((a, b) => b.confidence - a.confidence || (a.dedupeKey < b.dedupeKey ? -1 : 1))
  let open = 0
  const counterpartOf = (candidate: Candidate) =>
    tidied.find(
      (suggestion) =>
        !used.has(suggestion.id) &&
        suggestion.status === "open" &&
        suggestion.kind === candidate.kind &&
        (candidate.kind === "save-to-project" ? suggestion.dedupeKey === candidate.dedupeKey : overlap(suggestion.recordKeys, candidate.recordKeys) >= 0.5)
    )

  const updated = new Map<string, Suggestion>()
  const created: Suggestion[] = []
  for (const candidate of candidates) {
    const recordKeys = candidate.recordKeys.filter((key) => !claimed.has(key))
    if (recordKeys.length === 0 || (candidate.kind === "create-project" && recordKeys.length < 2)) continue
    const existing = counterpartOf(candidate)
    if (!existing && open >= config.maxOpenSuggestions) continue
    for (const key of recordKeys) claimed.add(key)
    open += 1
    const fresh: Candidate = { ...candidate, recordKeys }
    if (existing) {
      used.add(existing.id)
      const grew = recordKeys.some((key) => !existing.recordKeys.includes(key))
      const same =
        sameMembers(existing.recordKeys, recordKeys) &&
        existing.confidence === fresh.confidence &&
        existing.band === fresh.band &&
        sameEvidence(existing.evidence, fresh.evidence) &&
        JSON.stringify(existing.destination) === JSON.stringify(fresh.destination) &&
        sameMembers(existing.alternatives, fresh.alternatives)
      if (same) {
        updated.set(existing.id, existing)
      } else {
        updated.set(existing.id, {
          ...existing,
          ...fresh,
          // A new project keeps the name the person may already have seen, unless its pages changed.
          destination: existing.destination.kind === "new-project" && fresh.destination.kind === "new-project" && !grew ? existing.destination : fresh.destination,
          updatedAt: now,
          expiresAt: grew ? Math.max(existing.expiresAt, now + config.expiryDays * DAY) : existing.expiresAt,
        })
      }
    } else {
      created.push({ ...fresh, id: input.mintId(), createdAt: now, updatedAt: now, expiresAt: now + config.expiryDays * DAY, status: "open" })
    }
  }

  for (const suggestion of tidied) {
    const replaced = updated.get(suggestion.id)
    if (replaced) {
      next.push(replaced)
      continue
    }
    if (suggestion.status !== "open") {
      next.push(suggestion)
      continue
    }
    // Not found again this run. Kept while its pages are still waiting (evidence wobbles; the suggestion
    // shouldn't), minus any page saved, rejected or claimed by another suggestion since.
    const remaining = suggestion.recordKeys.filter((key) => eligibleKeys.has(key) && !claimed.has(key))
    const enough = suggestion.kind === "create-project" ? remaining.length >= 2 : remaining.length >= 1
    if (!enough) {
      next.push({ ...suggestion, status: "expired", decidedAt: now })
      continue
    }
    for (const key of remaining) claimed.add(key)
    next.push(sameMembers(remaining, suggestion.recordKeys) ? suggestion : { ...suggestion, recordKeys: remaining, updatedAt: now })
  }
  next.push(...created)

  const changed = next.length !== before.length || next.some((suggestion, index) => suggestion !== before[index])
  return { suggestions: changed ? next : (before as Suggestion[]), changed, matches }
}

/** A project with pages provisionally matched to it as extra, weaker evidence. */
function withProvisional(project: ProjectFeatures, pages: readonly RecordFeatures[] | undefined): ProjectFeatures {
  if (!pages || pages.length === 0) return project
  const terms = new Map(project.terms)
  const spelling = new Map(project.spelling)
  for (const page of pages) {
    for (const [term, weight] of page.terms) {
      if (term.startsWith("site:")) continue
      terms.set(term, (terms.get(term) ?? 0) + Math.min(weight, 1) * PROVISIONAL_WEIGHT)
    }
    for (const [word, spelled] of page.spelling) if (!spelling.has(word)) spelling.set(word, spelled)
  }
  return { ...project, terms, spelling }
}

/** Several pages as one: each word weighted by the share of pages that use it. */
function groupFeatures(pages: readonly RecordFeatures[]): RecordFeatures {
  const terms = new Map<string, number>()
  const spelling = new Map<string, string>()
  for (const page of pages) {
    for (const [term, weight] of page.terms) terms.set(term, (terms.get(term) ?? 0) + Math.min(weight, 1) / pages.length)
    for (const [word, spelled] of page.spelling) if (!spelling.has(word)) spelling.set(word, spelled)
  }
  return { key: pages.map((page) => page.key).join("|"), terms, spelling, fromContent: pages.some((page) => page.fromContent), order: [] }
}

/** Words in the order a title that has them all says them: "Sugar tax", not "Tax sugar". */
function inTitleOrder(words: readonly string[], pages: readonly RecordFeatures[]): string[] {
  const witness = pages.find((page) => words.every((word) => page.order.includes(word)))
  return witness ? [...words].sort((a, b) => witness.order.indexOf(a) - witness.order.indexOf(b)) : [...words]
}

function featureTitleHas(record: ActivityRecord, term: string, featuresOf: (record: ActivityRecord) => RecordFeatures): boolean {
  // A word is from the text when the title alone wouldn't have it: its weight is no more than a content word's.
  const weight = featuresOf(record).terms.get(term) ?? 0
  return weight >= 1
}

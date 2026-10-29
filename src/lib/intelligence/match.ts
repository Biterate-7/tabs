import { clamp01, DEFAULT_CONFIG } from "./scoring"
import { projectTemporal } from "./temporal"
import { REJECT_ANY } from "./types"
import type { ProjectFeatures, RecordFeatures } from "./features"
import type { InferenceConfig } from "./scoring"
import type { SimilarityProvider } from "./similarity"
import type { ActivityRecord, Rejection } from "./types"

/**
 * Existing projects first: before anything suggests a new project, every
 * page is compared with the projects the person already has.
 *
 *   semantic   how much of the page's topic the project already covers
 *              (similarity.ts), plus whether the page names the project's
 *              own subject ("economics" for an Economics IA)
 *   temporal   × (1 + boost) when the project was being worked on at the
 *              same time — only once the topic alone clears a floor
 *   feedback   0 when the person said "not this project" for this page;
 *              less when they rejected similar pages for it before
 */

export type ProjectScore = {
  workspaceId: string
  score: number
  semantic: number
  temporal: number
  feedbackPenalty: number
  /** Stemmed words shared with the project, strongest first. */
  shared: string[]
  /** Words of the project's name the page uses. */
  nameHits: string[]
}

const NAME_BONUS = 0.25

/** How much a page resembles what was rejected for `target`, from the words kept with each rejection. */
export function rejectionSimilarity(page: RecordFeatures, rejections: readonly Rejection[], target: string): number {
  let best = 0
  for (const rejection of rejections) {
    if (rejection.target !== target || !rejection.terms?.length) continue
    const words = rejection.terms
    let hit = 0
    for (const word of words) if (page.terms.has(word)) hit += 1
    best = Math.max(best, hit / words.length)
  }
  return best
}

export function scoreProject(input: {
  record: ActivityRecord
  page: RecordFeatures
  project: ProjectFeatures
  projectLastAt?: number
  similarity: SimilarityProvider
  rejections: readonly Rejection[]
  config?: InferenceConfig
}): ProjectScore {
  const { record, page, project, similarity, rejections } = input
  const config = input.config ?? DEFAULT_CONFIG
  const blank: ProjectScore = { workspaceId: project.workspaceId, score: 0, semantic: 0, temporal: 0, feedbackPenalty: 0, shared: [], nameHits: [] }
  if (rejections.some((rejection) => rejection.key === record.key && (rejection.target === project.workspaceId || rejection.target === REJECT_ANY))) {
    return { ...blank, feedbackPenalty: 1 }
  }
  const covered = similarity.coverage(page, project)
  const nameHits = project.nameTerms.filter((word) => page.terms.has(word))
  const nameShare = project.nameTerms.length > 0 ? nameHits.length / project.nameTerms.length : 0
  // Naming the project's subject only counts alongside topic evidence: "economics" alone is any economics page.
  const semantic = clamp01(covered.score + (covered.shared.length > nameHits.length ? NAME_BONUS * nameShare : 0))
  if (semantic === 0) return blank
  const temporal = semantic >= config.temporalFloor ? projectTemporal(record, input.projectLastAt) : 0
  const penalty = rejectionSimilarity(page, rejections, project.workspaceId)
  const score = clamp01(semantic * (1 + config.temporalBoost * temporal) * (1 - config.rejectionPenalty * penalty))
  return { workspaceId: project.workspaceId, score, semantic, temporal, feedbackPenalty: penalty, shared: covered.shared, nameHits }
}

/** Every project's score for a page, best first; only those that score at all. */
export function rankProjects(input: Omit<Parameters<typeof scoreProject>[0], "project" | "projectLastAt"> & { projects: readonly ProjectFeatures[]; lastAt: ReadonlyMap<string, number> }): ProjectScore[] {
  return input.projects
    .map((project) => scoreProject({ ...input, project, projectLastAt: input.lastAt.get(project.workspaceId) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.workspaceId < b.workspaceId ? -1 : 1))
}

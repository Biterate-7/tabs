import type { ConfidenceBand } from "./types"

/**
 * Every number the engine decides with, in one place, so it can be tested,
 * tuned and replaced as a whole.
 *
 * These were calibrated on the fixtures in engine.test.ts — realistic student
 * work: one Economics IA across a conversation, articles and a draft; two
 * assignments open at once; a personal chat; generic pages; work spread over
 * days. They are not a measured accuracy. The pilot should log decisions
 * (accepted, changed, rejected — counts only) and retune them here.
 */
export type InferenceConfig = {
  /** At or above: a strong association, offered as the default. */
  strong: number
  /** At or above (and below strong): worth asking about. Below: not enough evidence, nothing is said. */
  review: number
  /** Average similarity a group of pages must keep to stay one group. */
  clusterMerge: number
  /** Pages it takes for a new body of work to be suggested as a project. */
  minClusterSize: number
  /** A two-page group is suggested only this strongly connected. */
  pairClusterScore: number
  /** Two projects this close to each other are both offered, the best one first. */
  ambiguityMargin: number
  /** How much a shared work period can add (multiplier 1 + this). Never creates an association by itself. */
  temporalBoost: number
  /** Below this semantic score, timing is not considered at all. */
  temporalFloor: number
  /** How much the person's similar earlier rejections can take away (multiplier 1 − this × similarity). */
  rejectionPenalty: number
  /** Pages older than this are not suggested. */
  windowDays: number
  /** A page glanced at for less than this, once, is not evidence of anything. */
  minDwellMs: number
  maxOpenSuggestions: number
  maxPagesPerSuggestion: number
  /** An open suggestion nobody acted on goes after this many days. */
  expiryDays: number
  /** "Not now" is honoured for this many days. */
  snoozeDays: number
}

export const DEFAULT_CONFIG: Readonly<InferenceConfig> = Object.freeze({
  strong: 0.5,
  review: 0.3,
  clusterMerge: 0.18,
  minClusterSize: 3,
  pairClusterScore: 0.45,
  ambiguityMargin: 0.08,
  temporalBoost: 0.2,
  temporalFloor: 0.15,
  rejectionPenalty: 0.7,
  windowDays: 21,
  minDwellMs: 15_000,
  maxOpenSuggestions: 8,
  maxPagesPerSuggestion: 12,
  expiryDays: 7,
  snoozeDays: 3,
})

export type Band = ConfidenceBand | "insufficient"

export function bandOf(score: number, config: Pick<InferenceConfig, "strong" | "review"> = DEFAULT_CONFIG): Band {
  if (score >= config.strong) return "strong"
  if (score >= config.review) return "review"
  return "insufficient"
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

import { clamp01, DEFAULT_CONFIG } from "./scoring"
import { pairTemporal } from "./temporal"
import type { RecordFeatures } from "./features"
import type { InferenceConfig } from "./scoring"
import type { SimilarityProvider } from "./similarity"
import type { ActivityRecord } from "./types"

/**
 * New bodies of work: pages no existing project covers, grouped when they
 * are about the same thing.
 *
 * Average-linkage agglomerative clustering (the method Smart Organize uses),
 * deterministic — ties go to the earlier page. An average, not one shared
 * word, has to hold a group together, so an Economics IA and a Maths
 * homework open in the same hour stay two groups: timing multiplies a topic
 * score and never creates one (`pairTemporal` only counts above the floor).
 */

export type Cluster = {
  /** Indexes into the pages given. */
  members: number[]
  /** Average similarity inside the group. */
  cohesion: number
  /** Stemmed words most of its pages share, most-shared first. */
  sharedTerms: string[]
  temporal: number
}

export function pairScore(a: ActivityRecord, b: ActivityRecord, fa: RecordFeatures, fb: RecordFeatures, similarity: SimilarityProvider, config: InferenceConfig = DEFAULT_CONFIG): { score: number; temporal: number } {
  const semantic = similarity.pair(fa, fb).score
  if (semantic < config.temporalFloor / 2) return { score: semantic, temporal: 0 }
  const temporal = pairTemporal(a, b)
  return { score: clamp01(semantic * (1 + config.temporalBoost * temporal)), temporal }
}

/** Words a majority of a group's pages share (at least two pages), most-shared first. */
export function sharedWords(features: readonly RecordFeatures[]): string[] {
  const coverage = new Map<string, number>()
  for (const page of features) for (const term of page.terms.keys()) if (!term.startsWith("site:")) coverage.set(term, (coverage.get(term) ?? 0) + 1)
  const needed = Math.max(2, Math.ceil(features.length * 0.5))
  return [...coverage.entries()]
    .filter(([, count]) => count >= needed)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([term]) => term)
}

export function clusterPages(records: readonly ActivityRecord[], features: readonly RecordFeatures[], similarity: SimilarityProvider, config: InferenceConfig = DEFAULT_CONFIG): Cluster[] {
  const n = records.length
  if (n < 2) return []
  const sim = new Float64Array(n * n)
  const time = new Float64Array(n * n)
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const { score, temporal } = pairScore(records[i]!, records[j]!, features[i]!, features[j]!, similarity, config)
      sim[i * n + j] = score
      sim[j * n + i] = score
      time[i * n + j] = temporal
      time[j * n + i] = temporal
    }
  }
  const members: number[][] = Array.from({ length: n }, (_, index) => [index])
  const active = new Array<boolean>(n).fill(true)
  const total = Float64Array.from(sim)
  for (;;) {
    let best = -1
    let bestA = -1
    let bestB = -1
    for (let a = 0; a < n; a += 1) {
      if (!active[a]) continue
      for (let b = a + 1; b < n; b += 1) {
        if (!active[b]) continue
        const sum = total[a * n + b]!
        if (sum === 0) continue
        const average = sum / (members[a]!.length * members[b]!.length)
        if (average > best) {
          best = average
          bestA = a
          bestB = b
        }
      }
    }
    if (bestA < 0 || best < config.clusterMerge) break
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === bestA || k === bestB) continue
      const merged = total[bestA * n + k]! + total[bestB * n + k]!
      total[bestA * n + k] = merged
      total[k * n + bestA] = merged
    }
    members[bestA] = [...members[bestA]!, ...members[bestB]!].sort((x, y) => x - y)
    active[bestB] = false
  }

  const clusters: Cluster[] = []
  members.forEach((group, index) => {
    if (!active[index] || group.length < 2) return
    let sum = 0
    let timeSum = 0
    let pairs = 0
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        sum += sim[group[a]! * n + group[b]!]!
        timeSum += time[group[a]! * n + group[b]!]!
        pairs += 1
      }
    }
    clusters.push({ members: group, cohesion: pairs > 0 ? sum / pairs : 0, sharedTerms: sharedWords(group.map((i) => features[i]!)), temporal: pairs > 0 ? timeSum / pairs : 0 })
  })
  return clusters.sort((a, b) => b.members.length - a.members.length || a.members[0]! - b.members[0]!)
}

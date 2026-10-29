import type { ProjectFeatures, RecordFeatures, Terms } from "./features"

/**
 * How alike two things are, as a provider the engine is handed — so a richer
 * method (embeddings computed on the device, or a remote model the person
 * consented to) can replace this one without touching the engine.
 *
 * The provider Hubble ships is local and deterministic: weighted topic words
 * with inverse document frequency. It needs no key, no network and no
 * model, so the feature works for everyone; anything better must be an
 * explicit, consented addition with this as its fallback.
 */

export type Match = {
  /** 0..1 */
  score: number
  /** The stemmed words behind the score, strongest first. */
  shared: string[]
}

export type SimilarityProvider = {
  id: string
  /** Symmetric: how alike two pages are. */
  pair(a: RecordFeatures, b: RecordFeatures): Match
  /** Asymmetric: how much of what the page is about the project already covers. */
  coverage(record: RecordFeatures, project: ProjectFeatures): Match
}

const NONE: Match = Object.freeze({ score: 0, shared: Object.freeze([]) as unknown as string[] })

/** One shared word is thin evidence; two make a topic; three settle it. */
export function evidenceStrength(sharedTopicWords: number): number {
  if (sharedTopicWords <= 0) return 0
  if (sharedTopicWords === 1) return 0.5
  if (sharedTopicWords === 2) return 0.85
  return 1
}

function weighted(terms: Terms, idf: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [term, weight] of terms) out.set(term, weight * (idf.get(term) ?? 1))
  return out
}

function norm(vector: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const value of vector.values()) sum += value * value
  return Math.sqrt(sum)
}

export function createLocalSimilarity(idf: ReadonlyMap<string, number>): SimilarityProvider {
  const cache = new WeakMap<Terms, { vector: Map<string, number>; norm: number }>()
  const vectorOf = (terms: Terms) => {
    let entry = cache.get(terms)
    if (!entry) {
      const vector = weighted(terms, idf)
      entry = { vector, norm: norm(vector) }
      cache.set(terms, entry)
    }
    return entry
  }

  return {
    id: "local-topic-words",
    pair(a, b) {
      const left = vectorOf(a.terms)
      const right = vectorOf(b.terms)
      if (left.norm === 0 || right.norm === 0) return NONE
      const [small, large] = left.vector.size <= right.vector.size ? [left.vector, right.vector] : [right.vector, left.vector]
      let dot = 0
      const contributions: [string, number][] = []
      for (const [term, value] of small) {
        const other = large.get(term)
        if (other === undefined) continue
        dot += value * other
        if (!term.startsWith("site:")) contributions.push([term, value * other])
      }
      // A shared site alone is not a topic.
      if (contributions.length === 0) return NONE
      contributions.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      return { score: Math.min(1, dot / (left.norm * right.norm)), shared: contributions.map(([term]) => term) }
    },
    coverage(record, project) {
      let total = 0
      let covered = 0
      const contributions: [string, number][] = []
      for (const [term, weight] of record.terms) {
        if (term.startsWith("site:")) continue
        const value = weight * (idf.get(term) ?? 1)
        total += value
        const inProject = project.terms.get(term)
        if (inProject === undefined) continue
        // A word the project uses once counts in full; the project's size never inflates a page's score.
        const part = value * Math.min(1, inProject)
        covered += part
        contributions.push([term, part])
      }
      if (total === 0 || contributions.length === 0) return NONE
      contributions.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      return { score: (covered / total) * evidenceStrength(contributions.length), shared: contributions.map(([term]) => term) }
    },
  }
}

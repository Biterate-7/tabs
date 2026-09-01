/**
 * Reuse-before-create matching (spec §11/§20): before the AI or a user
 * creates a new section, check whether an existing sibling already means the
 * same thing — "Physics"/"Physics Research" should collapse into one
 * section, not fork into two.
 */

function normalizeToken(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

/** Redundant qualifiers that don't change a section's meaning — stripped before comparison only, never mutating a name a user or the AI actually chose. */
const REDUNDANT_SUFFIXES = [
  "research",
  "resources",
  "materials",
  "study",
  "stuff",
  "notes",
  "docs",
  "documents",
  "links",
  "misc",
  "miscellaneous",
];

function stripRedundantSuffix(normalized: string): string {
  const words = normalized.split(" ");
  if (words.length <= 1) return normalized;
  const last = words[words.length - 1];
  return REDUNDANT_SUFFIXES.includes(last) ? words.slice(0, -1).join(" ") : normalized;
}

/** Small hand-picked synonym groups for names that mean the same broad concept but share no tokens. */
const SYNONYM_GROUPS: string[][] = [
  ["university", "college"],
  ["ml", "machine learning"],
  ["ai", "artificial intelligence"],
  ["cs", "computer science"],
  ["econ", "economics"],
  ["bio", "biology"],
  ["chem", "chemistry"],
  ["math", "maths", "mathematics"],
  ["psych", "psychology"],
];

function synonymCanonical(normalized: string): string {
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(normalized)) return group[0];
  }
  return normalized;
}

function canonicalize(name: string): string {
  return synonymCanonical(stripRedundantSuffix(normalizeToken(name)));
}

function tokenize(canonical: string): Set<string> {
  return new Set(canonical.split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const FUZZY_MATCH_THRESHOLD = 0.6;

/**
 * Finds the existing sibling name (from `existingSiblingNames`) that most
 * plausibly means the same thing as `candidateName`, or `null` if none do.
 * Exact (post-normalization) matches win outright; otherwise falls back to
 * token-Jaccard similarity, only above FUZZY_MATCH_THRESHOLD.
 */
export function findSimilarSibling(existingSiblingNames: string[], candidateName: string): string | null {
  const candidateCanonical = canonicalize(candidateName);
  if (!candidateCanonical) return null;

  for (const existing of existingSiblingNames) {
    if (canonicalize(existing) === candidateCanonical) return existing;
  }

  const candidateTokens = tokenize(candidateCanonical);
  let best: { name: string; score: number } | null = null;
  for (const existing of existingSiblingNames) {
    const score = jaccard(candidateTokens, tokenize(canonicalize(existing)));
    if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { name: existing, score };
    }
  }
  return best?.name ?? null;
}

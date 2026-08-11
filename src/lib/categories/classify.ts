import { CATEGORY_ORDER } from "./definitions";
import { RULES } from "./rules";
import { toUrlContext } from "./context";
import type { CategoryId, CategoryScores, Classification } from "./types";

const MIN_CONFIDENT_SCORE = 40;
const MAX_SCORE = 100;

function emptyScores(): CategoryScores {
  const scores = {} as CategoryScores;
  for (const id of CATEGORY_ORDER) scores[id] = 0;
  return scores;
}

export function scoreUrl(normalizedUrl: string): CategoryScores {
  const scores = emptyScores();
  let ctx;
  try {
    ctx = toUrlContext(normalizedUrl);
  } catch {
    return scores;
  }

  for (const rule of RULES) {
    if (rule.test(ctx)) {
      scores[rule.category] = Math.min(
        MAX_SCORE,
        scores[rule.category] + rule.score
      );
    }
  }

  return scores;
}

function argmaxCategory(scores: CategoryScores): CategoryId {
  let best: CategoryId = CATEGORY_ORDER[0];
  for (const id of CATEGORY_ORDER) {
    if (scores[id] > scores[best]) best = id;
  }
  return best;
}

export function classifyUrl(normalizedUrl: string): Classification {
  const scores = scoreUrl(normalizedUrl);
  const winner = argmaxCategory(scores);
  const winningScore = scores[winner];

  if (winningScore < MIN_CONFIDENT_SCORE) {
    return {
      category: "other",
      confidence: Math.max(0, winningScore / MAX_SCORE),
      scores,
    };
  }

  return {
    category: winner,
    confidence: Math.min(1, winningScore / MAX_SCORE),
    scores,
  };
}

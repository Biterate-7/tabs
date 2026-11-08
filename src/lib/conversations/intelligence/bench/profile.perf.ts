import { it } from "vitest";
import { syntheticCorpus } from "../__fixtures__/synthetic";
import { buildCorpus, deriveIndex } from "../corpus";
import { extractConversation } from "../extract";
import { answerQuery, parseQuery } from "../retrieve";
import { DEFAULT_INTELLIGENCE_SETTINGS } from "../settings";

/** Where the time goes, stage by stage and query by query (SIZE=n). */
it("profiles the stages", () => {
  const size = Number(process.env.SIZE ?? 1000);
  const now = Date.UTC(2026, 9, 30);
  const corpus = syntheticCorpus(size);
  const extractions = new Map(corpus.records.map((record) => [record.id, extractConversation(record)]));
  let t = performance.now();
  const built = buildCorpus({ records: corpus.records, extractions, settings: DEFAULT_INTELLIGENCE_SETTINGS });
  console.log("corpus", Math.round(performance.now() - t), "relations", built.relations.length);
  t = performance.now();
  const index = deriveIndex(built, DEFAULT_INTELLIGENCE_SETTINGS, now);
  console.log("derive", Math.round(performance.now() - t), "facts", index.facts.length);
  for (const text of ["What did I decide about postgres?", "Which questions are still open?", "What did Claude suggest about oauth?", "sourdough hydration", "tasks from last week", "What did I accomplish this month?", "kubernetes ingress helm", "What did ChatGPT suggest that I later discussed with Claude?"]) {
    for (let round = 0; round < 2; round++) {
      t = performance.now();
      answerQuery(index, parseQuery(text, now));
      if (round === 1) console.log("query", Math.round(performance.now() - t), text);
    }
  }
});

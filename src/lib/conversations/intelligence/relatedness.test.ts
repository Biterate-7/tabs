import { describe, expect, it } from "vitest";
import { DAY, NOW, a, record, u } from "./__fixtures__/conversations";
import { syntheticCorpus } from "./__fixtures__/synthetic";
import { INDEX_CONFIG, buildConversationIndex, buildCorpus, deriveIndex } from "./corpus";
import { extractConversation } from "./extract";
import { DEFAULT_INTELLIGENCE_SETTINGS, correctFact, pairKey, reviewPair } from "./settings";
import type { SemanticInput } from "./corpus";
import type { IntelligenceSettings } from "./settings";
import type { ConversationRecord } from "./types";

/**
 * How conversations relate once meaning is in play, and what decisions over
 * time come to: levels, vetoes, project context, the person's word, bounds,
 * and contradictions that keep history while naming the current state.
 * Vectors here are stand-ins with chosen similarities — what the rules do
 * with a similarity, not whether the model gives it (that is measured with
 * the real model in bench/quality.perf.ts).
 */

const extractions = (records: ConversationRecord[]) => new Map(records.map((r) => [r.id, extractConversation(r)]));

/** Unit vectors in 3-D whose pairwise cosines are what the test needs. */
function vectorsFor(pairs: Record<string, [number, number, number]>): SemanticInput {
  const vectors = new Map<string, Float32Array>();
  for (const [id, [x, y, z]] of Object.entries(pairs)) {
    const length = Math.hypot(x, y, z);
    vectors.set(id, new Float32Array([x / length, y / length, z / length]));
  }
  const neighbors = new Map<string, { id: string; score: number }[]>();
  for (const [id, vector] of vectors) {
    const list: { id: string; score: number }[] = [];
    for (const [other, w] of vectors) if (other !== id) list.push({ id: other, score: Math.round((vector[0]! * w[0]! + vector[1]! * w[1]! + vector[2]! * w[2]!) * 1000) / 1000 });
    neighbors.set(id, list.filter((entry) => entry.score >= 0.3).sort((x, y) => y.score - x.score));
  }
  return { neighbors, vectors };
}

const index = (records: ConversationRecord[], input: { semantic?: SemanticInput; names?: Record<string, string>; settings?: IntelligenceSettings } = {}) =>
  buildConversationIndex({
    records,
    extractions: extractions(records),
    settings: input.settings ?? DEFAULT_INTELLIGENCE_SETTINGS,
    now: NOW,
    ...(input.semantic ? { semantic: input.semantic } : {}),
    ...(input.names ? { workspaceNames: new Map(Object.entries(input.names)) } : {}),
  });

const signIn = record("signin", [u("Should the desktop app open the browser for sign-in or have its own login form?"), a("Open the system browser and use an authorization code flow with PKCE.")], { provider: "claude", workspaceId: "web", title: "Sign-in architecture" });
const tokens = record("tokens", [u("Where should the Tauri app keep the refresh token so other programs can't read it?"), a("Use the operating system's credential store and rotate it on every use.")], { provider: "gemini", workspaceId: "desktop", title: "Keeping credentials" });
const snake = record("snake", [u("What humidity does a ball python enclosure need?"), a("Keep the python's enclosure at 50 to 60 percent humidity.")], { workspaceId: "home", title: "Python humidity" });
const script = record("script", [u("Write a Python script that renames photos by date."), a("Use Python with Pillow to read EXIF dates and rename each photo.")], { provider: "claude", workspaceId: "side", title: "Python rename script" });

describe("relating by meaning", () => {
  it("links the same work in different words, says so, and threads it", () => {
    const semantic = vectorsFor({ [signIn.id]: [1, 0.15, 0], [tokens.id]: [1, 0.2, 0] });
    const built = index([signIn, tokens], { semantic, names: { web: "Hubble web", desktop: "Hubble desktop" } });
    const relation = built.relations.find((entry) => !entry.sameConversation)!;
    expect(relation.level).toBe("same-problem");
    expect(relation.lexical).toBe(0);
    expect(relation.semantic).toBeGreaterThan(0.9);
    expect(relation.reasons.join(" ")).toMatch(/Similar in meaning.*different words/);
    expect(built.threads).toHaveLength(1);
    // Without meaning, there is nothing to go on.
    expect(index([signIn, tokens]).relations).toHaveLength(0);
  });

  it("vetoes shared words when the two are far apart in meaning — the snake and the language", () => {
    const words = index([snake, script]);
    expect(words.relations.some((entry) => entry.level !== "shared-entity")).toBe(true);
    const semantic = vectorsFor({ [snake.id]: [1, 0, 0], [script.id]: [0, 1, 0] });
    const checked = index([snake, script], { semantic });
    expect(checked.relations.filter((entry) => entry.level !== "shared-entity")).toHaveLength(0);
    expect(checked.threads).toHaveLength(0);
  });

  it("treats the same subject in two differently named projects as a related topic, never one thread", () => {
    const shop = record("shop", [u("Removing an item from the cart in the client's React shop leaves the total stale; the handler reads cart from useState."), a("The handler closes over a stale cart in React state; use a functional setState update.")], { workspaceId: "shop", title: "React cart total stale" });
    const hubble = record("side", [u("The React sidebar count stays stale after deleting a project; it comes from useMemo over React state."), a("The list was mutated in place, so React state didn't change; return a new array.")], { provider: "claude", workspaceId: "hubble", title: "React sidebar count stale" });
    // Close in meaning (≈0.45) — the same kind of bug — but not close enough to be one problem across projects.
    const semantic = vectorsFor({ [shop.id]: [1, 0, 0], [hubble.id]: [0.5, 1, 0] });
    const named = index([shop, hubble], { semantic, names: { shop: "Client shop", hubble: "Hubble" } });
    const relation = named.relations.find((entry) => !entry.sameConversation)!;
    expect(relation.semantic).toBeLessThan(INDEX_CONFIG.semanticAnyProject);
    expect(relation.level).toBe("related-topic");
    expect(relation.reasons.join(" ")).toMatch(/different projects/);
    expect(named.threads).toHaveLength(0);
  });

  it("takes the person's word: a confirmed pair stays related at the level they gave", () => {
    const settings = reviewPair(DEFAULT_INTELLIGENCE_SETTINGS, snake.id, script.id, { verdict: "related", level: "same-project", proposed: "none", methods: [], lexical: 0 }, NOW);
    const semantic = vectorsFor({ [snake.id]: [1, 0, 0], [script.id]: [0, 1, 0] });
    const relation = index([snake, script], { semantic, settings }).relations.find((entry) => !entry.sameConversation)!;
    expect(relation).toMatchObject({ level: "same-project", confirmed: true });
    expect(relation.reasons[0]).toMatch(/You confirmed/);
  });

  it("keeps each conversation's strongest relations only", () => {
    const corpus = syntheticCorpus(400);
    const built = buildCorpus({ records: corpus.records, extractions: extractions(corpus.records), settings: DEFAULT_INTELLIGENCE_SETTINGS });
    const perRecord = new Map<string, number>();
    for (const relation of built.relations) for (const id of [relation.a, relation.b]) perRecord.set(id, (perRecord.get(id) ?? 0) + 1);
    // A pair is kept when either side keeps it, so a record can exceed its own cap only through others' choices — but the total stays bounded.
    expect(built.relations.length).toBeLessThanOrEqual(corpus.records.length * INDEX_CONFIG.relationsPerRecord);
    expect(built.nearMisses.length).toBeLessThanOrEqual(200);
  });

  it("re-derives facts after a correction without re-scoring a single pair", () => {
    const decided = record("decided", [u("Should sign-in open the browser?"), a("I would recommend opening the system browser."), u("Let us go with the browser flow and PKCE.")], { provider: "claude", workspaceId: "web", title: "Sign-in flow" });
    const records = [decided, tokens];
    const semantic = vectorsFor({ [decided.id]: [1, 0.15, 0], [tokens.id]: [1, 0.2, 0] });
    const corpus = buildCorpus({ records, extractions: extractions(records), settings: DEFAULT_INTELLIGENCE_SETTINGS, semantic });
    const first = deriveIndex(corpus, DEFAULT_INTELLIGENCE_SETTINGS, NOW);
    const fact = first.facts[0]!;
    const after = deriveIndex(corpus, correctFact(DEFAULT_INTELLIGENCE_SETTINGS, fact.id, { verdict: "rejected" }, NOW), NOW);
    expect(after.relations).toBe(first.relations);
    expect(after.threads).toBe(first.threads);
    expect(after.facts.some((entry) => entry.id === fact.id)).toBe(false);
  });
});

describe("decisions over time", () => {
  const chat = (id: string, text: string, reply: string, days: number, extra: Parameters<typeof record>[2] = {}) => record(id, [u(text), a(reply)], { updatedAt: NOW - days * DAY, title: "Sync server database", ...extra });

  it("keeps a changed decision as history and names the later one as current", () => {
    const earlier = chat("d1", "For the sync server let's use PostgreSQL with row-level locks.", "OK.", 20);
    const later = chat("d2", "For the sync server we decided to use SQLite instead of PostgreSQL.", "Fine.", 2, { provider: "claude" });
    const built = index([earlier, later]);
    const contradiction = built.contradictions.find((entry) => entry.kind === "changed-decision")!;
    expect(contradiction.current).toBe("later");
    const old = built.facts.find((fact) => fact.id === contradiction.earlier.id)!;
    expect(old.supersededBy).toBe(contradiction.later.id);
    // History stays — marked, and ranked below what is current.
    const memory = built.memories.find((entry) => entry.category === "project" && entry.text.includes("PostgreSQL with row-level"))!;
    expect(memory.superseded).toBe(true);
    const current = built.memories.find((entry) => entry.category === "project" && entry.text.includes("SQLite"))!;
    expect(current.relevance).toBeGreaterThan(memory.relevance);
  });

  it("notices two AI apps recommending different things, and leaves the decision to the person", () => {
    const chatgpt = chat("p1", "Which database should the sync server use?", "I'd recommend PostgreSQL for the sync server.", 6);
    const claude = chat("p2", "Which database fits the sync server best?", "I'd recommend SQLite for the sync server.", 3, { provider: "claude" });
    const built = index([chatgpt, claude]);
    const disagreement = built.contradictions.find((entry) => entry.kind === "providers-disagree")!;
    expect(disagreement.current).toBe("undecided");
    expect(disagreement.reason).toMatch(/ChatGPT and Claude recommended different things/);
    expect(built.facts.every((fact) => !fact.supersededBy)).toBe(true);
  });

  it("marks an AI recommendation the person later turned down in another conversation", () => {
    const suggested = chat("r1", "How should the sync server store data?", "I'd recommend MongoDB for the sync server storage.", 8);
    const rejected = chat("r2", "Let's not use MongoDB for the sync server storage.", "Understood.", 2, { provider: "claude" });
    const built = index([suggested, rejected]);
    const entry = built.contradictions.find((item) => item.kind === "rejected-suggestion")!;
    expect(entry.earlier.recordId).toBe(suggested.id);
    expect(built.facts.find((fact) => fact.id === entry.earlier.id)!.supersededBy).toBe(entry.later.id);
  });

  it("never calls two projects' different choices a contradiction", () => {
    const hubble = chat("x1", "For the sync server let's use PostgreSQL.", "OK.", 10, { workspaceId: "hubble" });
    const shop = chat("x2", "For the shop's sync server let's use MySQL.", "OK.", 2, { workspaceId: "shop", provider: "claude" });
    const built = index([hubble, shop], { names: { hubble: "Hubble", shop: "Client shop" } });
    expect(built.contradictions).toHaveLength(0);
  });
});

describe("pairs are keyed the same both ways", () => {
  it("pairKey is symmetric", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });
});

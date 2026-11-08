import { contentHash } from "@/lib/conversations/hash";
import { textTerms } from "@/lib/intelligence/features";
import { aiProviderName } from "@/lib/providers/registry";
import { foldName } from "./lexicon";
import { isProviderAnalyzed, pairKey } from "./settings";
import { EXTRACTOR_VERSION } from "./types";
import { recordFingerprint } from "./canonical";
import type { AiProviderId } from "@/lib/providers/registry";
import type { IntelligenceSettings } from "./settings";
import type { SemanticNeighbor } from "./semantic";
import type {
  Contradiction,
  ConversationExtraction,
  ConversationIndex,
  ConversationRecord,
  ConversationThread,
  Evidence,
  Fact,
  Insight,
  Memory,
  MemoryCategory,
  NearMiss,
  ProcessingState,
  Relation,
  RelationLevel,
  ResolvedEntity,
  Topic,
} from "./types";

/**
 * Everything Hubble understands across the person's saved AI conversations,
 * built from the per-conversation extractions in two stages:
 *
 *   buildCorpus   which conversations are analysed, their topics, names
 *                 resolved across conversations, how pairs relate, threads.
 *                 Depends on the text and on which conversations are in —
 *                 never on corrections to facts, so correcting a fact or
 *                 dismissing an insight never re-scores a single pair.
 *   deriveIndex   facts after corrections, decisions over time,
 *                 contradictions, memory, insights. Cheap; runs on every
 *                 correction.
 *
 * Pure and deterministic: the same inputs always give the same index.
 *
 * ## How two conversations relate
 *
 * Four kinds of evidence, each kept on the relation so the UI can say why:
 *
 *   words     distinctive topic words both use (tf-idf), and named things
 *             both mention (a library, a project) — never the AI app's name
 *   meaning   how close the two conversations are in an embedding model's
 *             space (./semantic.ts), when the person turned it on
 *   project   whether they sit in the same Hubble project, projects whose
 *             names share a word, or name the same project
 *   time      how far apart they happened
 *
 * and four levels, strongest first:
 *
 *   same-problem   strong evidence and nothing saying they belong to
 *                  different projects. Only these form threads.
 *   same-project   related, in the same project context
 *   related-topic  related, with no shared project context — the same kind
 *                  of bug in two different projects lands here
 *   shared-entity  only a distinctive name in common; shown, never threaded
 *
 * The person's word overrides all of it: a pair they said is unrelated is
 * never related; a pair they confirmed is related (at the level they said).
 *
 * ## Bounded
 *
 * Each conversation keeps its strongest `relationsPerRecord` relations, so
 * thousands of conversations about a few subjects never become hundreds of
 * thousands of edges.
 */

export const INDEX_CONFIG = {
  topicsPerConversation: 6,
  vectorTerms: 30,
  postingTerms: 15,
  /** Lexical (words + names) score below which a pair is not related. */
  relatedScore: 0.12,
  /** Lexical score at or above which, with a shared name or three words, a pair can be the same problem. */
  threadScore: 0.16,
  /** Lexical score that is the same problem even across projects (with three shared words). */
  lexicalAnyProject: 0.35,
  /*
   * Meaning thresholds (cosine of all-MiniLM-L6-v2 conversation vectors),
   * read off the labelled set's distribution (bench/quality.perf.ts): there,
   * unrelated pairs never passed 0.27 and same-problem pairs ran 0.30–0.59,
   * with same-project / related-topic pairs up to ~0.40.
   */
  /** Related at all. */
  semanticTopic: 0.3,
  /** The same problem, in a shared or unknown project context. */
  semanticProblem: 0.42,
  /** The same problem even across projects. */
  semanticAnyProject: 0.55,
  /** Below this, shared words are coincidence: the two are about different things. */
  semanticVeto: 0.15,
  /** Candidates scored per conversation, and relations kept per conversation. */
  lexicalCandidates: 24,
  relationsPerRecord: 12,
  /** A name in more conversations than this share is not distinctive enough to relate two on its own. */
  sharedEntityMaxDf: 6,
  /** Average linkage two groups must keep to merge into one thread. */
  threadLinkage: 0.2,
  threadMax: 20,
  workingHalfLifeDays: 7,
  projectHalfLifeDays: 90,
  workingRevalidateDays: 14,
  unfinishedAfterDays: 3,
  progressWindowDays: 7,
  insightMin: 0.5,
  insights: 8,
  insightsPerKind: 3,
} as const;

const DAY = 86_400_000;

/** What the corpus stage reads from the settings — corrections to facts are not among them. */
export type CorpusSettings = Pick<IntelligenceSettings, "enabled" | "providers" | "excluded" | "unrelated" | "related" | "reviews">;

export type SemanticInput = {
  /** Nearest others per record id, from ./semantic.ts: candidates that share no words. */
  neighbors: ReadonlyMap<string, readonly SemanticNeighbor[]>;
  /** Each embedded record's unit vector — so any candidate pair gets its exact similarity. */
  vectors: ReadonlyMap<string, Float32Array>;
};

export type CorpusInput = {
  records: readonly ConversationRecord[];
  /** By record id. A record without one (or with a stale one) is pending. */
  extractions: ReadonlyMap<string, ConversationExtraction>;
  settings: CorpusSettings;
  /** Records whose analysis threw. */
  failed?: ReadonlySet<string>;
  semantic?: SemanticInput;
  /** Project names by id, for "projects whose names share a word". */
  workspaceNames?: ReadonlyMap<string, string>;
};

export type IndexInput = CorpusInput & { settings: IntelligenceSettings; now: number };

export type Corpus = {
  records: ConversationRecord[];
  extractions: ReadonlyMap<string, ConversationExtraction>;
  processing: ReadonlyMap<string, ProcessingState>;
  primaries: ConversationRecord[];
  copiesOf: ReadonlyMap<string, ConversationRecord[]>;
  recordById: ReadonlyMap<string, ConversationRecord>;
  topics: ReadonlyMap<string, Topic[]>;
  entities: ResolvedEntity[];
  relations: Relation[];
  /** Pairs with some evidence that fell short of a link — what the person's review samples to find missed links. */
  nearMisses: NearMiss[];
  threads: ConversationThread[];
  /** Whether meaning-level evidence took part, and for how many conversations. */
  semantic: { used: boolean; embedded: number };
};

/** Whether a record is analysed at all, under the person's settings. */
export function isAnalyzable(record: ConversationRecord, settings: Pick<IntelligenceSettings, "enabled" | "providers" | "excluded">): boolean {
  return settings.enabled && isProviderAnalyzed(settings as IntelligenceSettings, record.provider) && !settings.excluded.includes(record.identity) && record.ingestion === "ready";
}

/** An extraction that still describes the record as saved now, by the current extractor. */
export function isCurrent(record: ConversationRecord, extraction: ConversationExtraction | undefined): extraction is ConversationExtraction {
  return !!extraction && extraction.version === EXTRACTOR_VERSION && extraction.fingerprint === recordFingerprint(record);
}

function shortHash(text: string): string {
  return contentHash({ text }).slice(0, 10);
}

function decay(age: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, age) / (halfLifeDays * DAY));
}

function intersect(a: readonly string[], b: ReadonlySet<string>): string[] {
  return a.filter((value) => b.has(value));
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Words in project names that say nothing about which project it is.
const GENERIC_PROJECT_WORDS = new Set(["project", "projects", "work", "notes", "note", "misc", "inbox", "general", "stuff", "personal", "my", "new", "old", "todo", "ideas", "research", "untitled", "default", "the", "and"]);

function projectWords(name: string | undefined): Set<string> {
  if (!name) return new Set();
  return new Set(textTerms(name).words.filter((word) => word.length >= 3 && !GENERIC_PROJECT_WORDS.has(word)));
}

export function buildConversationIndex(input: IndexInput): ConversationIndex {
  return deriveIndex(buildCorpus(input), input.settings, input.now);
}

export function buildCorpus({ records, extractions, settings, failed, semantic, workspaceNames }: CorpusInput): Corpus {
  const processing = new Map<string, ProcessingState>();
  const analyzed: ConversationRecord[] = [];
  for (const record of records) {
    const extraction = extractions.get(record.id);
    if (!isAnalyzable(record, settings)) processing.set(record.id, "excluded");
    else if (isCurrent(record, extraction)) {
      processing.set(record.id, "analyzed");
      analyzed.push(record);
    } else processing.set(record.id, failed?.has(record.id) ? "failed" : "pending");
  }

  // One conversation saved into two projects is one conversation: the fullest copy speaks for it.
  const byIdentity = new Map<string, ConversationRecord[]>();
  for (const record of analyzed) {
    const group = byIdentity.get(record.identity);
    if (group) group.push(record);
    else byIdentity.set(record.identity, [record]);
  }
  const primaries: ConversationRecord[] = [];
  const copiesOf = new Map<string, ConversationRecord[]>();
  const primaryOf = new Map<string, string>();
  const relations: Relation[] = [];
  for (const group of byIdentity.values()) {
    const sorted = [...group].sort((x, y) => y.messages.length - x.messages.length || y.syncedAt - x.syncedAt || (x.id < y.id ? -1 : 1));
    primaries.push(sorted[0]!);
    copiesOf.set(sorted[0]!.id, sorted);
    for (const copy of sorted) primaryOf.set(copy.id, sorted[0]!.id);
    for (const copy of sorted.slice(1))
      relations.push({ a: sorted[0]!.id, b: copy.id, score: 1, level: "same-problem", lexical: 1, sharedTerms: [], sharedEntities: [], sharedProjects: [], sameConversation: true, reasons: ["The same conversation, saved in two projects."] });
  }
  const recordById = new Map(records.map((record) => [record.id, record]));
  const ext = (record: ConversationRecord) => extractions.get(record.id)!;
  const workspaceSets = new Map<string, Set<string>>();
  const workspacesOfPrimary = (recordId: string) => {
    let set = workspaceSets.get(recordId);
    if (!set) workspaceSets.set(recordId, (set = new Set((copiesOf.get(recordId) ?? [recordById.get(recordId)!]).map((record) => record.workspaceId))));
    return set;
  };
  const nameWords = new Map<string, Set<string>>();
  const wordsOfWorkspace = (id: string) => {
    let set = nameWords.get(id);
    if (!set) nameWords.set(id, (set = projectWords(workspaceNames?.get(id))));
    return set;
  };

  // ── Topics ────────────────────────────────────────────────────────────────
  const df = new Map<string, number>();
  for (const record of primaries) for (const term of Object.keys(ext(record).terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const total = primaries.length;
  const idf = (term: string) => Math.log(1 + total / (df.get(term) ?? 1));
  // A word in most conversations ("app", "code") describes the person, not a topic.
  const tooCommon = (term: string) => total >= 6 && (df.get(term) ?? 0) / total > 0.5;
  const topics = new Map<string, Topic[]>();
  const vectors = new Map<string, Map<string, number>>();
  const norms = new Map<string, number>();
  for (const record of primaries) {
    const extraction = ext(record);
    const weighted = Object.entries(extraction.terms)
      .filter(([term]) => !tooCommon(term))
      .map(([term, tf]) => [term, Math.log(1 + tf) * idf(term)] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const vector = new Map(weighted.slice(0, INDEX_CONFIG.vectorTerms));
    vectors.set(record.id, vector);
    let sum = 0;
    for (const value of vector.values()) sum += value * value;
    norms.set(record.id, Math.sqrt(sum));
    const list = weighted.slice(0, INDEX_CONFIG.topicsPerConversation).map(([term, weight]) => ({ term, label: extraction.spelling[term] ?? term, weight: Math.round(weight * 100) / 100 }));
    for (const copy of copiesOf.get(record.id) ?? [record]) topics.set(copy.id, list);
  }

  // ── Entities, resolved across conversations ───────────────────────────────
  const entities = resolveEntities(primaries.map((record) => ({ recordId: record.id, entities: ext(record).entities })));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const distinctiveOf = new Map<string, Set<string>>();
  const projectsOf = new Map<string, Set<string>>();
  for (const entity of entities) {
    // AI apps and big companies come up everywhere; resources (a URL) are too specific to be a theme.
    const distinctive = entity.kind !== "organization" && entity.kind !== "resource" && !(entity.kind === "product" && /^(chatgpt|claude|gemini|perplexity|grok)$/.test(entity.id));
    for (const recordId of entity.recordIds) {
      if (distinctive) {
        const set = distinctiveOf.get(recordId) ?? new Set<string>();
        set.add(entity.id);
        distinctiveOf.set(recordId, set);
      }
      if (entity.kind === "project") {
        const set = projectsOf.get(recordId) ?? new Set<string>();
        set.add(entity.id);
        projectsOf.set(recordId, set);
      }
    }
  }
  const EMPTY = new Set<string>();
  const entityIdf = (id: string) => Math.log(1 + total / (entityById.get(id)?.recordIds.length ?? 1));

  // ── Candidates: by shared words (an accumulated partial dot product), and by meaning ──
  const unrelated = new Set(settings.unrelated);
  const confirmed = new Set(settings.related ?? []);
  // Postings over each conversation's strongest words, by position, with the word's weight there.
  const position = new Map(primaries.map((record, index) => [record.id, index]));
  const postings = new Map<string, { at: number[]; weight: number[] }>();
  primaries.forEach((record, index) => {
    let count = 0;
    for (const [term, weight] of vectors.get(record.id)!) {
      if (count++ >= INDEX_CONFIG.postingTerms) break;
      const list = postings.get(term) ?? { at: [], weight: [] };
      list.at.push(index);
      list.weight.push(weight);
      postings.set(term, list);
    }
  });
  const maxPosting = Math.max(30, Math.ceil(total * 0.3));
  const candidates = new Set<string>();
  const partial = new Float64Array(total);
  const touched: number[] = [];
  const best: number[] = [];
  primaries.forEach((record, index) => {
    let count = 0;
    for (const [term, weight] of vectors.get(record.id)!) {
      if (count++ >= INDEX_CONFIG.postingTerms) break;
      const list = postings.get(term)!;
      if (list.at.length > maxPosting) continue;
      for (let entry = 0; entry < list.at.length; entry++) {
        const other = list.at[entry]!;
        if (other === index) continue;
        if (partial[other] === 0) touched.push(other);
        partial[other] += weight * list.weight[entry]!;
      }
    }
    for (const id of distinctiveOf.get(record.id) ?? EMPTY) {
      const entity = entityById.get(id)!;
      if (entity.recordIds.length > INDEX_CONFIG.sharedEntityMaxDf) continue;
      for (const otherId of entity.recordIds) {
        const other = position.get(otherId)!;
        if (other === index) continue;
        if (partial[other] === 0) touched.push(other);
        partial[other] += 0.001;
      }
    }
    // The strongest few, kept in order as they are found: no sort of everything touched.
    best.length = 0;
    const better = (x: number, y: number) => partial[x]! > partial[y]! || (partial[x] === partial[y] && x < y);
    for (const other of touched) {
      if (best.length === INDEX_CONFIG.lexicalCandidates && !better(other, best[best.length - 1]!)) continue;
      let at = best.length;
      while (at > 0 && better(other, best[at - 1]!)) at--;
      best.splice(at, 0, other);
      if (best.length > INDEX_CONFIG.lexicalCandidates) best.pop();
    }
    for (const other of best) candidates.add(pairKey(record.id, primaries[other]!.id));
    for (const other of touched) partial[other] = 0;
    touched.length = 0;
  });
  if (semantic) {
    for (const record of primaries) {
      for (const neighbor of semantic.neighbors.get(record.id) ?? []) {
        const other = primaryOf.get(neighbor.id);
        if (other && other !== record.id && neighbor.score >= INDEX_CONFIG.semanticTopic) candidates.add(pairKey(record.id, other));
      }
    }
  }
  const meaningOf = (a: string, b: string) => {
    const va = semantic?.vectors.get(a);
    const vb = semantic?.vectors.get(b);
    if (!va || !vb) return undefined;
    let sum = 0;
    for (let index = 0; index < va.length; index++) sum += va[index]! * vb[index]!;
    return round3(sum);
  };
  for (const key of confirmed) {
    const [a, b] = key.split("|") as [string, string];
    const pa = primaryOf.get(a);
    const pb = primaryOf.get(b);
    if (pa && pb && pa !== pb) candidates.add(pairKey(pa, pb));
  }

  // ── Scoring and levels ────────────────────────────────────────────────────
  const scored: Relation[] = [];
  const nearMisses: NearMiss[] = [];
  for (const key of candidates) {
    if (unrelated.has(key)) continue;
    const [a, b] = key.split("|") as [string, string];
    const va = vectors.get(a)!;
    const vb = vectors.get(b)!;
    let dot = 0;
    const sharedTerms: [string, number][] = [];
    const [small, large] = va.size <= vb.size ? [va, vb] : [vb, va];
    for (const [term, value] of small) {
      const other = large.get(term);
      if (other === undefined) continue;
      dot += value * other;
      sharedTerms.push([term, value * other]);
    }
    const cosine = dot === 0 ? 0 : dot / (norms.get(a)! * norms.get(b)!);
    const ea = distinctiveOf.get(a) ?? EMPTY;
    const eb = distinctiveOf.get(b) ?? EMPTY;
    const sharedEntities: string[] = [];
    for (const id of ea) if (eb.has(id)) sharedEntities.push(id);
    sharedEntities.sort();
    const smaller = ea.size <= eb.size ? ea : eb;
    let sharedWeight = 0;
    let smallerWeight = 0;
    for (const id of sharedEntities) sharedWeight += entityIdf(id);
    for (const id of smaller) smallerWeight += entityIdf(id);
    const entityScore = smallerWeight === 0 ? 0 : sharedWeight / smallerWeight;
    // Evidence gate: two shared words make a topic; one word needs a shared name beside it.
    const wordsGate = sharedTerms.length >= 2 || (sharedTerms.length >= 1 && sharedEntities.length >= 1);
    const lexical = wordsGate ? round3(Math.min(1, 0.6 * cosine + 0.4 * entityScore)) : 0;
    const meaning = meaningOf(a, b);

    // Project context: the same project, projects whose names share a word, or a project both name.
    const wa = workspacesOfPrimary(a);
    const wb = workspacesOfPrimary(b);
    const sameWorkspace = [...wa].some((id) => wb.has(id));
    const sharedProjects = [...(projectsOf.get(a) ?? EMPTY)].filter((id) => (projectsOf.get(b) ?? EMPTY).has(id)).sort();
    let namesKnown = false;
    let namesShare = false;
    if (workspaceNames && !sameWorkspace) {
      const wordsA = new Set([...wa].flatMap((id) => [...wordsOfWorkspace(id)]));
      const wordsB = new Set([...wb].flatMap((id) => [...wordsOfWorkspace(id)]));
      namesKnown = [...wa, ...wb].every((id) => workspaceNames.has(id));
      namesShare = [...wordsA].some((word) => wordsB.has(word));
    }
    const projectContext = sameWorkspace || sharedProjects.length > 0 || namesShare;
    // Only a known difference counts against: two different, differently named projects, and no project both name.
    const differentProjects = !projectContext && namesKnown;

    // Words, checked by meaning when there is one: words two conversations share while being far apart in meaning are coincidence ("python" the snake and the language).
    const vetoed = meaning !== undefined && meaning < INDEX_CONFIG.semanticVeto;
    const lexicalRelated = !vetoed && lexical >= INDEX_CONFIG.relatedScore;
    // With meaning available, only closeness in meaning makes two conversations the same problem; shared words make them related.
    const lexicalStrong = meaning === undefined && lexical >= INDEX_CONFIG.threadScore && (sharedEntities.length >= 1 || sharedTerms.length >= 3);
    const semanticRelated = meaning !== undefined && meaning >= INDEX_CONFIG.semanticTopic;
    const semanticStrong = meaning !== undefined && meaning >= INDEX_CONFIG.semanticProblem;
    // Only meaning can claim the same problem across two projects known to be different: words alone were wrong about "same problem" far too often (bench/quality.perf.ts).
    const veryStrong = (meaning === undefined && !differentProjects && lexical >= INDEX_CONFIG.lexicalAnyProject && sharedTerms.length >= 3) || (meaning !== undefined && meaning >= INDEX_CONFIG.semanticAnyProject);
    const distinctiveShared = sharedEntities.filter((id) => (entityById.get(id)?.recordIds.length ?? 99) <= INDEX_CONFIG.sharedEntityMaxDf);

    const review = settings.reviews?.[key];
    const isConfirmed = confirmed.has(key);
    let level: RelationLevel | undefined;
    if (isConfirmed && review?.level) level = review.level;
    else if (veryStrong || ((lexicalStrong || semanticStrong) && !differentProjects)) level = "same-problem";
    else if ((lexicalRelated || semanticRelated) && projectContext) level = "same-project";
    else if (lexicalRelated || semanticRelated) level = "related-topic";
    else if (distinctiveShared.length > 0 && (sharedTerms.length >= 1 || projectContext)) level = "shared-entity";
    if (isConfirmed && (!level || level === "shared-entity")) level = "related-topic";
    if (!level) {
      if (cosine > 0 || (meaning ?? 0) >= 0.2) nearMisses.push({ a, b, lexical: round3(Math.min(1, 0.6 * cosine + 0.4 * entityScore)), ...(meaning !== undefined ? { semantic: meaning } : {}), sharedTerms: sharedTerms.map(([term]) => term).slice(0, 6), sharedEntities: sharedEntities.slice(0, 6) });
      continue;
    }

    // One score for ordering: either kind of evidence can carry it, agreement lifts it.
    const lexicalStrength = clamp01((lexical - 0.08) / 0.3);
    const meaningStrength = meaning === undefined ? 0 : clamp01((meaning - 0.2) / 0.4);
    const days = Math.abs(recordById.get(a)!.updatedAt - recordById.get(b)!.updatedAt) / DAY;
    let score = 1 - (1 - lexicalStrength) * (1 - meaningStrength);
    if (projectContext) score += 0.05;
    if (days <= 14) score += 0.03;
    if (level === "shared-entity") score = Math.min(score, 0.3);
    if (isConfirmed) score = Math.max(score, 0.9);
    score = round3(clamp01(score));

    const sharedTermList = sharedTerms.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([term]) => term).slice(0, 6);
    const reasons: string[] = [];
    if (isConfirmed) reasons.push("You confirmed these are related.");
    if (meaning !== undefined && meaning >= INDEX_CONFIG.semanticTopic) reasons.push(`Similar in meaning (${Math.round(meaning * 100)}% by the on-device model)${lexical === 0 ? ", even though they use different words" : ""}.`);
    if (sharedEntities.length > 0) reasons.push(`Both mention ${sharedEntities.slice(0, 3).map((id) => entityById.get(id)?.name ?? id).join(", ")}.`);
    if (sharedTermList.length >= 2) reasons.push(`Shared distinctive words: ${sharedTermList.slice(0, 4).join(", ")}.`);
    if (vetoed && (sharedTermList.length > 0 || sharedEntities.length > 0)) reasons.push("They share words, but the on-device model finds them about different things.");
    if (sameWorkspace) reasons.push("Saved in the same project.");
    else if (sharedProjects.length > 0) reasons.push(`Both name the project ${sharedProjects.map((id) => entityById.get(id)?.name ?? id).join(", ")}.`);
    else if (namesShare) reasons.push("Saved in projects with related names.");
    else if (differentProjects) reasons.push("Saved in different projects, so Hubble treats this as a related topic, not the same work.");
    if (days <= 14) reasons.push(days < 1.5 ? "Within a day of each other." : `${Math.round(days)} days apart.`);

    scored.push({
      a,
      b,
      score,
      level,
      lexical,
      ...(meaning !== undefined ? { semantic: meaning } : {}),
      sharedTerms: sharedTermList,
      sharedEntities: sharedEntities.slice(0, 6),
      sharedProjects,
      ...(sameWorkspace ? { sameWorkspace: true } : {}),
      ...(isConfirmed ? { confirmed: true } : {}),
      reasons,
    });
  }

  // Each conversation keeps its strongest relations; a pair stays when either side keeps it.
  const LEVEL_RANK: Record<RelationLevel, number> = { "same-problem": 3, "same-project": 2, "related-topic": 1, "shared-entity": 0 };
  const rank = (relation: Relation) => (relation.confirmed ? 10 : 0) + LEVEL_RANK[relation.level] + relation.score;
  const perRecord = new Map<string, Relation[]>();
  for (const relation of scored)
    for (const id of [relation.a, relation.b]) {
      const list = perRecord.get(id);
      if (list) list.push(relation);
      else perRecord.set(id, [relation]);
    }
  const kept = new Set<Relation>();
  for (const list of perRecord.values()) for (const relation of list.sort((x, y) => rank(y) - rank(x) || (pairKey(x.a, x.b) < pairKey(y.a, y.b) ? -1 : 1)).slice(0, INDEX_CONFIG.relationsPerRecord)) kept.add(relation);
  for (const relation of scored) if (kept.has(relation)) relations.push(relation);

  const pairScores = new Map<string, number>();
  for (const relation of relations) if (!relation.sameConversation && relation.level === "same-problem") pairScores.set(pairKey(relation.a, relation.b), relation.score);
  const threads = buildThreads(primaries, pairScores, topics, copiesOf, ext);

  return {
    records: [...records],
    extractions,
    processing,
    primaries,
    copiesOf,
    recordById,
    topics,
    entities,
    relations,
    nearMisses: nearMisses.sort((x, y) => Math.max(y.lexical, y.semantic ?? 0) - Math.max(x.lexical, x.semantic ?? 0)).slice(0, 200),
    threads,
    semantic: { used: !!semantic && semantic.vectors.size > 0, embedded: semantic ? primaries.filter((record) => semantic.vectors.has(record.id)).length : 0 },
  };
}

/** Facts after the person's corrections, decisions over time, memory and insights, over a built corpus. */
export function deriveIndex(corpus: Corpus, settings: IntelligenceSettings, now: number): ConversationIndex {
  const { primaries, copiesOf, recordById, threads, relations } = corpus;
  const ext = (record: ConversationRecord) => corpus.extractions.get(record.id)!;
  const workspacesOf = (recordId: string) => [...new Set((copiesOf.get(recordId) ?? [recordById.get(recordId)!]).map((record) => record.workspaceId))].sort();

  const correctionOf = (fact: Fact) => {
    const own = settings.facts[fact.id];
    if (own) return own;
    // A correction made on another project's copy of the same conversation counts here too.
    const suffix = fact.id.slice(fact.recordId.length);
    for (const copy of copiesOf.get(fact.recordId) ?? []) {
      const correction = settings.facts[`${copy.id}${suffix}`];
      if (correction) return correction;
    }
    return undefined;
  };
  const timeOf = (fact: Fact) => fact.at ?? recordById.get(fact.recordId)!.updatedAt;
  const facts: Fact[] = [];
  const corrected = new Set<string>();
  for (const record of primaries) {
    for (const fact of ext(record).facts) {
      const correction = correctionOf(fact);
      if (correction?.verdict === "rejected") continue;
      const next: Fact = { ...fact };
      if (correction?.status) {
        next.status = correction.status;
        // "That was only the AI's suggestion": the person's word moves a decision back to the AI.
        if (correction.status === "suggested") next.attribution = "assistant";
        next.corrected = true;
        corrected.add(fact.id);
      }
      if (correction?.verdict === "confirmed") {
        next.confidence = 1;
        next.corrected = true;
        corrected.add(fact.id);
      }
      facts.push(next);
    }
  }
  const threadOf = new Map<string, string>();
  for (const thread of threads) for (const id of thread.recordIds) threadOf.set(id, thread.id);

  // Which conversations count as the same work for facts across them: one thread, or a same-problem / same-project relation.
  const together = new Set<string>();
  for (const relation of relations) if (relation.level === "same-problem" || relation.level === "same-project") together.add(pairKey(relation.a, relation.b));
  const sameWork = (x: string, y: string) => {
    if (x === y) return true;
    const tx = threadOf.get(x);
    if (tx !== undefined && tx === threadOf.get(y)) return true;
    if (together.has(pairKey(x, y))) return true;
    const wx = workspacesOf(x);
    return workspacesOf(y).some((id) => wx.includes(id));
  };

  // A commitment a later conversation reports done is done.
  const doneByTerm = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.kind !== "task" || fact.status !== "done") continue;
    for (const term of fact.terms) doneByTerm.set(term, [...(doneByTerm.get(term) ?? []), fact]);
  }
  for (const fact of facts) {
    if (fact.kind !== "task" || fact.status !== "committed" || corrected.has(fact.id)) continue;
    const terms = new Set(fact.terms);
    const seen = new Set<Fact>();
    let done: Fact | undefined;
    for (const term of fact.terms) {
      for (const signal of doneByTerm.get(term) ?? []) {
        if (seen.has(signal)) continue;
        seen.add(signal);
        if (signal.recordId === fact.recordId || timeOf(signal) < timeOf(fact)) continue;
        const sameThread = threadOf.get(signal.recordId) !== undefined && threadOf.get(signal.recordId) === threadOf.get(fact.recordId);
        const overlap = intersect(signal.terms, terms).length;
        const named = signal.entities.some((id) => fact.entities.includes(id));
        if (overlap >= 2 || (overlap >= 1 && (named || sameThread))) {
          done = signal;
          break;
        }
      }
      if (done) break;
    }
    if (done) {
      fact.status = "done";
      fact.rule = "done-later";
      fact.evidence = [...fact.evidence, ...done.evidence];
    }
  }

  const contradictions = findContradictions(facts, threadOf, timeOf, sameWork, recordById);
  // The current state: a decision a later one replaced, or a suggestion the person later went against, says so — and stays in history.
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const contradiction of contradictions) {
    if (contradiction.kind === "providers-disagree") continue;
    const earlier = byId.get(contradiction.earlier.id);
    if (earlier && !earlier.supersededBy) earlier.supersededBy = contradiction.later.id;
  }
  const memories = buildMemories({ facts, threads, contradictions, entities: corpus.entities, now, workspacesOf, recordById, timeOf, settings });
  const insights = buildInsights({ facts, threads, contradictions, now, timeOf, recordById, settings });

  return {
    records: corpus.records,
    extractions: corpus.extractions,
    topics: corpus.topics,
    entities: corpus.entities,
    relations,
    nearMisses: corpus.nearMisses,
    threads,
    facts,
    contradictions,
    memories,
    insights,
    processing: corpus.processing,
    semantic: corpus.semantic,
  };
}

// ── Entity resolution ───────────────────────────────────────────────────────

const GENERIC_SUFFIX = /\s(?:app|project|service|api|repo|codebase|tool|platform|system)$/;

/**
 * Names across conversations, resolved. Lexicon entities are already one id
 * per thing. A name found in the text merges with another only when they are
 * the same name once case, punctuation, a plural "s" or a trailing "app" /
 * "project" are set aside — "Hubble app" and "Hubble" — and both are at least
 * one real word. Similar-looking but different names ("Auth" and "Author")
 * never merge.
 */
export function resolveEntities(inputs: readonly { recordId: string; entities: ConversationExtraction["entities"] }[]): ResolvedEntity[] {
  const resolved = new Map<string, ResolvedEntity>();
  const canonicalOf = (id: string, name: string) => {
    if (!id.startsWith("x:")) return id;
    const folded = foldName(name).replace(GENERIC_SUFFIX, "").replace(/(?<=[a-z]{3})s$/, "");
    return folded.length >= 3 ? `x:${folded}` : id;
  };
  for (const { recordId, entities } of inputs) {
    for (const entity of entities) {
      const id = canonicalOf(entity.id, entity.name);
      const current = resolved.get(id);
      if (!current) {
        resolved.set(id, { id, name: entity.name, kind: entity.kind, recordIds: [recordId], mentions: entity.mentions, confidence: entity.confidence });
        continue;
      }
      if (current.recordIds[current.recordIds.length - 1] !== recordId && !current.recordIds.includes(recordId)) current.recordIds.push(recordId);
      current.mentions += entity.mentions;
      if (entity.kind === "project") current.kind = "project";
      if (foldName(entity.name) !== foldName(current.name)) {
        const merged = current.merged ?? [];
        if (!merged.some((entry) => entry.name === entity.name)) merged.push({ name: entity.name, confidence: id === entity.id ? 0.9 : 0.75 });
        current.merged = merged;
      }
      // Seen in more conversations, a recurring name is more likely a real thing.
      if (id.startsWith("x:")) current.confidence = Math.min(0.9, Math.max(current.confidence, entity.confidence) + 0.1);
    }
  }
  return [...resolved.values()].sort((a, b) => b.recordIds.length - a.recordIds.length || b.mentions - a.mentions || (a.id < b.id ? -1 : 1));
}

// ── Threads ─────────────────────────────────────────────────────────────────

function buildThreads(
  primaries: readonly ConversationRecord[],
  pairScores: ReadonlyMap<string, number>,
  topics: ReadonlyMap<string, Topic[]>,
  copiesOf: ReadonlyMap<string, ConversationRecord[]>,
  ext: (record: ConversationRecord) => ConversationExtraction
): ConversationThread[] {
  const group = new Map<string, string[]>(primaries.map((record) => [record.id, [record.id]]));
  const owner = new Map<string, string>(primaries.map((record) => [record.id, record.id]));
  const ordered = [...pairScores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [key] of ordered) {
    const [a, b] = key.split("|") as [string, string];
    const ga = owner.get(a)!;
    const gb = owner.get(b)!;
    if (ga === gb) continue;
    const left = group.get(ga)!;
    const right = group.get(gb)!;
    if (left.length + right.length > INDEX_CONFIG.threadMax) continue;
    let sum = 0;
    for (const x of left) for (const y of right) sum += pairScores.get(pairKey(x, y)) ?? 0;
    if (sum / (left.length * right.length) < INDEX_CONFIG.threadLinkage) continue;
    const merged = [...left, ...right];
    group.set(ga, merged);
    group.delete(gb);
    for (const id of right) owner.set(id, ga);
  }
  const byId = new Map(primaries.map((record) => [record.id, record]));
  const threads: ConversationThread[] = [];
  for (const members of group.values()) {
    if (members.length < 2) continue;
    const records = members.map((id) => byId.get(id)!).sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    // The thread's words: topics at least two of its conversations share.
    const counts = new Map<string, { count: number; weight: number; label: string }>();
    for (const record of records) {
      for (const topic of topics.get(record.id) ?? []) {
        const current = counts.get(topic.term) ?? { count: 0, weight: 0, label: topic.label };
        current.count += 1;
        current.weight += topic.weight;
        counts.set(topic.term, current);
      }
      for (const [term, weight] of Object.entries(ext(record).terms).slice(0, 40)) {
        if ((topics.get(record.id) ?? []).some((topic) => topic.term === term)) continue;
        const current = counts.get(term) ?? { count: 0, weight: 0, label: ext(record).spelling[term] ?? term };
        current.count += 1;
        current.weight += weight * 0.1;
        counts.set(term, current);
      }
    }
    const terms = [...counts.entries()].filter(([, entry]) => entry.count >= 2).sort((a, b) => b[1].count - a[1].count || b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1));
    let pairs = 0;
    let sum = 0;
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        pairs += 1;
        sum += pairScores.get(pairKey(members[i]!, members[j]!)) ?? 0;
      }
    const all = records.flatMap((record) => copiesOf.get(record.id) ?? [record]);
    threads.push({
      id: `t:${shortHash([...members].sort().join(","))}`,
      label: terms.slice(0, 3).map(([, entry]) => entry.label).join(", ") || records[0]!.title,
      recordIds: records.map((record) => record.id),
      providers: [...new Set(records.map((record) => record.provider).filter((provider): provider is AiProviderId => !!provider))],
      workspaceIds: [...new Set(all.map((record) => record.workspaceId))].sort(),
      terms: terms.slice(0, 8).map(([term]) => term),
      confidence: Math.round((sum / Math.max(1, pairs)) * 100) / 100,
      startedAt: Math.min(...records.map((record) => record.createdAt)),
      updatedAt: Math.max(...records.map((record) => record.updatedAt)),
    });
  }
  return threads.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

// ── Decisions over time ─────────────────────────────────────────────────────

const SETTLED = (fact: Fact) => fact.kind === "decision" && (fact.status === "decided" || fact.status === "accepted");

/**
 * Where what was decided — or recommended — changed or disagrees, always
 * keeping both sides:
 *
 *   changed-decision     the person settled on one thing, then later on another
 *                        (or said the later one replaces the earlier)
 *   rejected-suggestion  an AI recommended something; later the person turned
 *                        it down or settled on something else
 *   providers-disagree   two AI apps recommended different things for the same
 *                        work, and the person hasn't settled it
 *
 * Only within the same work — the same conversation, project, thread or a
 * same-problem/same-project relation. Two projects that happen to decide
 * differently about a similar subject are not a contradiction.
 */
function findContradictions(
  facts: readonly Fact[],
  threadOf: ReadonlyMap<string, string>,
  timeOf: (fact: Fact) => number,
  sameWork: (a: string, b: string) => boolean,
  recordById: ReadonlyMap<string, ConversationRecord>
): Contradiction[] {
  type Info = { choice: Set<string>; terms: Set<string>; order: number };
  const info = new Map<Fact, Info>();
  const decisions = facts
    .filter((fact) => fact.kind === "decision" && (SETTLED(fact) || fact.status === "suggested" || fact.status === "rejected"))
    .sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : 1));
  decisions.forEach((fact, order) => info.set(fact, { choice: new Set(fact.entities.filter((id) => !id.startsWith("x:") && !id.startsWith("u:") && !id.startsWith("f:"))), terms: new Set(fact.terms), order }));
  const providerOf = (fact: Fact) => recordById.get(fact.recordId)?.provider;
  const out: Contradiction[] = [];
  const found = new Set<string>();

  const consider = (earlier: Fact, later: Fact) => {
    const key = `${earlier.id}|${later.id}`;
    if (found.has(key)) return;
    const e = info.get(earlier)!;
    const l = info.get(later)!;
    const disjoint = e.choice.size > 0 && l.choice.size > 0 && ![...e.choice].some((id) => l.choice.has(id));
    const overlapChoice = [...e.choice].some((id) => l.choice.has(id));
    const replaces = later.replaces ? foldName(later.replaces) : "";
    const explicit = SETTLED(later) && replaces.length > 0 && [...e.choice].some((id) => replaces.includes(id) || foldName(earlier.text).includes(replaces.split(" ")[0]!));
    // What a pair could be, before the costlier checks.
    const couldChange = SETTLED(earlier) && SETTLED(later) && (explicit || disjoint);
    const couldTurnDown = earlier.status === "suggested" && later.recordId !== earlier.recordId && ((later.status === "rejected" && later.attribution === "user") || (SETTLED(later) && disjoint));
    const couldDisagree = earlier.status === "suggested" && later.status === "suggested" && disjoint && providerOf(earlier) !== providerOf(later);
    if (!couldChange && !couldTurnDown && !couldDisagree) return;
    const subject = [...e.terms].filter((term) => l.terms.has(term) && !e.choice.has(term) && !l.choice.has(term));
    const thread = threadOf.get(later.recordId);
    const onSubject = subject.length > 0 || (thread !== undefined && thread === threadOf.get(earlier.recordId));
    if (!sameWork(earlier.recordId, later.recordId)) return;

    let kind: Contradiction["kind"] | undefined;
    let reason = "";
    let confidence = 0.55;
    if (couldChange && (explicit || onSubject)) {
      kind = "changed-decision";
      reason = explicit ? `The later decision says it replaces “${later.replaces}”.` : `Both decide about “${subject.slice(0, 3).join(", ") || "the same work"}” but choose differently.`;
      confidence = explicit ? 0.8 : subject.length > 0 ? 0.65 : 0.55;
    } else if (couldTurnDown && later.status === "rejected" && (overlapChoice || subject.length >= 2)) {
      kind = "rejected-suggestion";
      reason = `${aiProviderName(providerOf(earlier))} recommended it; later you turned it down.`;
      confidence = overlapChoice ? 0.7 : 0.55;
    } else if (couldTurnDown && SETTLED(later) && disjoint && onSubject) {
      kind = "rejected-suggestion";
      reason = `${aiProviderName(providerOf(earlier))} recommended one thing; later you settled on another.`;
      confidence = subject.length > 0 ? 0.65 : 0.55;
    } else if (couldDisagree && onSubject) {
      kind = "providers-disagree";
      reason = `${aiProviderName(providerOf(earlier))} and ${aiProviderName(providerOf(later))} recommended different things for “${subject.slice(0, 3).join(", ") || "the same work"}”.`;
      confidence = subject.length > 0 ? 0.6 : 0.5;
    }
    if (!kind) return;
    found.add(key);
    out.push({ id: `c:${shortHash(key)}`, kind, earlier, later, reason, confidence, current: kind === "providers-disagree" ? "undecided" : "later" });
  };

  // Every kind but a plain "no" needs a named choice on both sides (or a later "instead of …"):
  // only those decisions are paired, by a shared word, choice or thread.
  const choosers = decisions.filter((fact) => info.get(fact)!.choice.size > 0 || (SETTLED(fact) && fact.replaces));
  const byKey = new Map<string, Fact[]>();
  const index = (key: string, fact: Fact) => {
    const list = byKey.get(key);
    if (list) list.push(fact);
    else byKey.set(key, [fact]);
  };
  for (const fact of choosers) {
    for (const term of info.get(fact)!.terms) index(`t:${term}`, fact);
    for (const id of info.get(fact)!.choice) index(`e:${id}`, fact);
    const thread = threadOf.get(fact.recordId);
    if (thread) index(`h:${thread}`, fact);
  }
  const poolOf = (later: Fact, keys: Map<string, Fact[]>) => {
    const pool = new Set<Fact>();
    const mine = info.get(later)!;
    for (const term of mine.terms) for (const fact of keys.get(`t:${term}`) ?? []) pool.add(fact);
    for (const id of mine.choice) for (const fact of keys.get(`e:${id}`) ?? []) pool.add(fact);
    const thread = threadOf.get(later.recordId);
    if (thread) for (const fact of keys.get(`h:${thread}`) ?? []) pool.add(fact);
    return [...pool].filter((fact) => info.get(fact)!.order < mine.order).sort((x, y) => info.get(y)!.order - info.get(x)!.order);
  };
  // Newest first, so the cap keeps what is most current.
  for (const later of [...choosers].reverse()) {
    for (const earlier of poolOf(later, byKey)) consider(earlier, later);
    if (out.length >= 40) return out;
  }
  // A plain "no" to something an AI recommended in another conversation: paired with suggestions by their words.
  const suggestions = new Map<string, Fact[]>();
  for (const fact of decisions) {
    if (fact.status !== "suggested") continue;
    for (const term of info.get(fact)!.terms) suggestions.set(`t:${term}`, [...(suggestions.get(`t:${term}`) ?? []), fact]);
  }
  for (const later of [...decisions].reverse()) {
    if (later.status !== "rejected" || later.attribution !== "user") continue;
    for (const earlier of poolOf(later, suggestions)) consider(earlier, later);
    if (out.length >= 40) return out;
  }
  return out;
}

// ── Memory ──────────────────────────────────────────────────────────────────

function buildMemories(input: {
  facts: readonly Fact[];
  threads: readonly ConversationThread[];
  contradictions: readonly Contradiction[];
  entities: readonly ResolvedEntity[];
  now: number;
  workspacesOf: (recordId: string) => string[];
  recordById: ReadonlyMap<string, ConversationRecord>;
  timeOf: (fact: Fact) => number;
  settings: IntelligenceSettings;
}): Memory[] {
  const { facts, threads, contradictions, entities, now, workspacesOf, recordById, timeOf, settings } = input;
  const memories = new Map<string, Memory>();
  const conflicted = new Set(contradictions.filter((entry) => entry.kind === "changed-decision").map((entry) => entry.earlier.id));
  const add = (category: MemoryCategory, text: string, fact: Pick<Fact, "attribution" | "confidence" | "evidence"> & { recordIds: string[]; id?: string; supersededBy?: string }, at: number, halfLife?: number) => {
    const key = `${category}:${foldName(text)}`;
    const corroboration = fact.recordIds.length;
    const recency = halfLife ? decay(now - at, halfLife) : 1;
    // A decision a later one replaced stays in memory, as history: it ranks below what is current.
    const current = fact.supersededBy ? 0.3 : 1;
    const confirmed = fact.id ? settings.facts[fact.id]?.verdict === "confirmed" : false;
    const existing = memories.get(key);
    if (existing) {
      existing.recordIds = [...new Set([...existing.recordIds, ...fact.recordIds])];
      existing.workspaceIds = [...new Set([...existing.workspaceIds, ...fact.recordIds.flatMap(workspacesOf)])].sort();
      existing.evidence = [...existing.evidence, ...fact.evidence].slice(0, 6);
      existing.at = Math.max(existing.at, at);
      existing.relevance = Math.round(existing.confidence * (halfLife ? decay(now - existing.at, halfLife) : 1) * (1 + 0.2 * (existing.recordIds.length - 1)) * (existing.superseded ? 0.3 : 1) * 1000) / 1000;
      return existing;
    }
    const memory: Memory = {
      id: `m:${shortHash(key)}`,
      category,
      text,
      attribution: fact.attribution,
      workspaceIds: [...new Set(fact.recordIds.flatMap(workspacesOf))].sort(),
      recordIds: [...fact.recordIds],
      evidence: fact.evidence.slice(0, 6),
      confidence: fact.confidence,
      relevance: Math.round(fact.confidence * recency * (1 + 0.2 * (corroboration - 1)) * current * 1000) / 1000,
      at,
      ...(confirmed ? { confirmed: true } : {}),
      ...(fact.id && conflicted.has(fact.id) ? { conflict: true } : {}),
      ...(fact.supersededBy ? { superseded: true } : {}),
    };
    memories.set(key, memory);
    return memory;
  };

  for (const fact of facts) {
    const at = timeOf(fact);
    const source = { ...fact, recordIds: [fact.recordId] };
    if ((fact.kind === "task" && fact.status === "committed") || fact.kind === "question") {
      if (now - at > 30 * DAY) continue;
      const memory = add("working", fact.kind === "question" ? `Open: ${fact.text}` : fact.text, source, at, INDEX_CONFIG.workingHalfLifeDays);
      memory.revalidateAfter = at + INDEX_CONFIG.workingRevalidateDays * DAY;
    } else if (SETTLED(fact)) {
      add("project", fact.text, source, at, INDEX_CONFIG.projectHalfLifeDays);
      if (fact.replaces) add("episodic", `Changed direction — ${fact.text}`, source, at);
    } else if (fact.kind === "knowledge" && fact.status === "confirmed") {
      add("project", fact.text, source, at, INDEX_CONFIG.projectHalfLifeDays);
    }
  }
  // Knowledge confirmed in more than one conversation is lasting.
  for (const memory of [...memories.values()]) {
    if (memory.category === "project" && memory.recordIds.length >= 2 && !memory.superseded) add("long-term", memory.text, { ...memory, recordIds: memory.recordIds }, memory.at);
  }
  for (const entity of entities) {
    if (entity.recordIds.length < 3 || entity.kind === "resource" || entity.kind === "organization") continue;
    let at = 0;
    for (const id of entity.recordIds) at = Math.max(at, recordById.get(id)?.updatedAt ?? 0);
    add("long-term", `You often work with ${entity.name} (${entity.recordIds.length} conversations)`, { attribution: "user", confidence: Math.min(0.9, entity.confidence), evidence: [], recordIds: entity.recordIds.slice(0, 20) }, at);
  }
  for (const contradiction of contradictions) {
    if (contradiction.kind !== "changed-decision") continue;
    add("episodic", `Changed direction — earlier: “${contradiction.earlier.text}” · later: “${contradiction.later.text}”`, { attribution: "user", confidence: contradiction.confidence, evidence: [...contradiction.earlier.evidence, ...contradiction.later.evidence], recordIds: [contradiction.earlier.recordId, contradiction.later.recordId] }, timeOf(contradiction.later));
  }
  for (const thread of threads) {
    if (thread.providers.length < 2) continue;
    const names = thread.providers.map((provider) => aiProviderName(provider)).join(", ");
    add("episodic", `Worked on ${thread.label} across ${names}`, { attribution: "user", confidence: thread.confidence, evidence: [], recordIds: thread.recordIds }, thread.updatedAt);
  }
  return [...memories.values()].sort((a, b) => b.relevance - a.relevance || b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, 300);
}

// ── Proactive insights ──────────────────────────────────────────────────────

function buildInsights(input: {
  facts: readonly Fact[];
  threads: readonly ConversationThread[];
  contradictions: readonly Contradiction[];
  now: number;
  timeOf: (fact: Fact) => number;
  recordById: ReadonlyMap<string, ConversationRecord>;
  settings: IntelligenceSettings;
}): Insight[] {
  const { facts, threads, contradictions, now, timeOf, recordById, settings } = input;
  const out: Insight[] = [];
  const idOf = (kind: string, key: string, recordIds: readonly string[]) => `${kind}:${shortHash(key)}@${[...new Set(recordIds)].sort().join(",")}`;
  const names = (recordIds: readonly string[]) => [...new Set(recordIds.map((id) => aiProviderName(recordById.get(id)?.provider)))].join(" and ");
  const threadOf = new Map<string, ConversationThread>();
  for (const thread of threads) for (const id of thread.recordIds) threadOf.set(id, thread);
  const factsByRecord = new Map<string, Fact[]>();
  for (const fact of facts) factsByRecord.set(fact.recordId, [...(factsByRecord.get(fact.recordId) ?? []), fact]);

  for (const thread of threads) {
    if (thread.providers.length < 2 && thread.workspaceIds.length < 2) continue;
    const across = thread.providers.length >= 2 ? `across ${names(thread.recordIds)}` : `in ${thread.workspaceIds.length} projects`;
    out.push({
      id: idOf("related-work", thread.id, thread.recordIds),
      kind: "related-work",
      title: `${thread.recordIds.length} conversations about ${thread.label}`,
      why: `Hubble found them to be about the same problem ${across}${thread.terms.length > 0 ? ` (shared: ${thread.terms.slice(0, 4).join(", ")})` : ""}.`,
      recordIds: thread.recordIds,
      evidence: [],
      confidence: Math.min(1, 0.4 + thread.confidence),
      suggestion: "Open the thread to see what was decided and what is still open, in one place.",
      threadId: thread.id,
      at: thread.updatedAt,
    });
  }
  for (const contradiction of contradictions) {
    out.push({
      id: idOf("inconsistency", contradiction.id, [contradiction.earlier.recordId, contradiction.later.recordId]),
      kind: "inconsistency",
      title:
        contradiction.kind === "providers-disagree"
          ? "Two AI apps recommended different things"
          : contradiction.kind === "rejected-suggestion"
            ? "You went another way than an AI recommended"
            : "A later decision replaces an earlier one",
      why: contradiction.reason,
      recordIds: [contradiction.earlier.recordId, contradiction.later.recordId],
      evidence: [...contradiction.earlier.evidence, ...contradiction.later.evidence],
      confidence: contradiction.confidence,
      suggestion: contradiction.kind === "providers-disagree" ? "Decide which one to follow — Hubble keeps both until you do." : "Check that the later one is what stands; the earlier one stays in history.",
      at: timeOf(contradiction.later),
    });
  }
  for (const fact of facts) {
    if (fact.kind !== "task" || fact.status !== "committed") continue;
    const age = now - timeOf(fact);
    if (age < INDEX_CONFIG.unfinishedAfterDays * DAY || age > 60 * DAY) continue;
    out.push({
      id: idOf("unfinished", fact.id, [fact.recordId]),
      kind: "unfinished",
      title: "You said you'd do this",
      why: `“${fact.text}” — ${Math.round(age / DAY)} days ago, and no later conversation says it was done.`,
      recordIds: [fact.recordId],
      evidence: fact.evidence,
      confidence: fact.confidence,
      suggestion: "Mark it done if it is, or pick it up from the conversation.",
      at: timeOf(fact),
    });
  }
  const questionsByThread = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.kind !== "question") continue;
    const thread = threadOf.get(fact.recordId);
    if (thread) questionsByThread.set(thread.id, [...(questionsByThread.get(thread.id) ?? []), fact]);
  }
  for (const [threadId, questions] of questionsByThread) {
    const thread = threads.find((entry) => entry.id === threadId)!;
    out.push({
      id: idOf("knowledge-gap", threadId, questions.map((fact) => fact.recordId)),
      kind: "knowledge-gap",
      title: `Still open in ${thread.label}`,
      why: `${questions.length === 1 ? "A question" : `${questions.length} questions`} in this work ${questions.length === 1 ? "has" : "have"} no answer that worked yet: “${questions[0]!.text}”`,
      recordIds: [...new Set(questions.map((fact) => fact.recordId))],
      evidence: questions.flatMap((fact) => fact.evidence).slice(0, 4),
      confidence: Math.max(...questions.map((fact) => fact.confidence)),
      suggestion: "Bring the thread's context into an AI chat and ask again — or note the answer if you found one.",
      threadId,
      at: Math.max(...questions.map(timeOf)),
    });
  }
  for (const thread of threads) {
    const recent = thread.recordIds
      .flatMap((id) => factsByRecord.get(id) ?? [])
      .filter((fact) => now - timeOf(fact) <= INDEX_CONFIG.progressWindowDays * DAY && (SETTLED(fact) || (fact.kind === "task" && fact.status === "done")));
    if (recent.length < 2) continue;
    const decisions = recent.filter((fact) => fact.kind === "decision").length;
    const done = recent.length - decisions;
    out.push({
      id: idOf("progress", `${thread.id}:${recent.map((fact) => fact.id).join(",")}`, thread.recordIds),
      kind: "progress",
      title: `Progress on ${thread.label}`,
      why: [decisions ? `${decisions} decision${decisions === 1 ? "" : "s"}` : "", done ? `${done} task${done === 1 ? "" : "s"} done` : ""].filter(Boolean).join(" and ") + " this week.",
      recordIds: thread.recordIds,
      evidence: recent.flatMap((fact) => fact.evidence).slice(0, 4),
      confidence: 0.7,
      suggestion: "Open the thread for a summary of what changed.",
      threadId: thread.id,
      at: Math.max(...recent.map(timeOf)),
    });
  }

  const dismissed = new Set(settings.dismissed);
  const perKind = new Map<string, number>();
  return out
    .filter((insight) => insight.confidence >= INDEX_CONFIG.insightMin && !dismissed.has(insight.id))
    .sort((a, b) => b.confidence * decay(now - b.at, 30) - a.confidence * decay(now - a.at, 30) || (a.id < b.id ? -1 : 1))
    .filter((insight) => {
      const count = perKind.get(insight.kind) ?? 0;
      perKind.set(insight.kind, count + 1);
      return count < INDEX_CONFIG.insightsPerKind;
    })
    .slice(0, INDEX_CONFIG.insights);
}

/** The evidence's own words for display, newest message last. */
export function evidenceOrder(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence].sort((a, b) => (a.recordId === b.recordId ? a.messageIndex - b.messageIndex : a.recordId < b.recordId ? -1 : 1));
}

import type { KnowledgeItemRef } from "@/lib/memory/items";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationCaptureMethod, ConversationRole } from "@/lib/resources/types";
import type { EntityKind } from "./lexicon";

/**
 * Conversation intelligence: what Hubble understands from the AI
 * conversations a person saved — not which AI sites they visited.
 *
 *   saved conversation ──► ConversationRecord ──► ConversationExtraction ──► ConversationIndex
 *   (Tab.resource / note,   canonical view:        per conversation, pure:     across conversations:
 *    turns in the content   ids, order, hashes,    topics, entities, intent,   threads, entities,
 *    store)                 content types          decisions, tasks, …         memories, insights
 *
 * Nothing here is a second store of conversations. Records are read from the
 * items Hubble already keeps (lib/memory/items, lib/resources/content-store);
 * extractions and embedding vectors are cached on this device (./store.ts)
 * under the same keys as the text and deleted by the content store's own
 * deletion paths, and the index is rebuilt from them — so deleting a
 * conversation deletes everything derived from it. What the person decided
 * about the results (./settings.ts) is pruned with the conversations.
 *
 * Imported text is untrusted data. Extraction reads it with fixed patterns,
 * never follows it, and attributes every statement to the turn's role as the
 * page or export recorded it — never to what the text claims about itself.
 */

/**
 * Bumped when extraction changes, so a cached result from an older version is
 * never reused. 2: every fact names the rule that found it.
 */
export const EXTRACTOR_VERSION = 2;

/** Whether Hubble holds the conversation's text and could analyse it. */
export type IngestionState = "ready" | "needs-text" | "unreadable";

/** Whether intelligence processing ran — tracked apart from ingestion, so failed analysis never means saving again. */
export type ProcessingState = "pending" | "analyzed" | "excluded" | "failed";

export type MessageContentType = "text" | "code" | "math" | "table" | "list" | "link";

export type ConversationMessage = {
  /** `<record id>#<index>`: stable while the conversation keeps its order. */
  id: string;
  index: number;
  role: ConversationRole;
  text: string;
  at?: number;
  /** Over the text only, so an edited message is told apart from an unchanged one. */
  hash: string;
  contentTypes: MessageContentType[];
  codeLanguages?: string[];
  /**
   * Content the page or export referred to but Hubble does not hold (an
   * image, an uploaded file, a generated chart). Named, never silently dropped.
   */
  unavailable?: string[];
};

export type ConversationRecord = {
  /** Hubble's id: `<project>:<item ref>` — one per saved copy. */
  id: string;
  /**
   * Which conversation it is, whatever project holds it: the provider's own
   * identity (`chatgpt:chat:<id>`, from lib/resources/url `sourceKey`), or
   * `note:<content hash>` for one saved without an address. Never the title.
   */
  identity: string;
  workspaceId: string;
  ref: KnowledgeItemRef;
  provider?: AiProviderId;
  /** The provider's id for it, from its address or export. */
  externalId?: string;
  title: string;
  url?: string;
  /** When the conversation started — the provider's own time when known, else when Hubble first saved it. */
  createdAt: number;
  /** When it last changed — the provider's own time when known, else the last save. */
  updatedAt: number;
  /** When Hubble last saved its text. */
  syncedAt: number;
  ingestion: IngestionState;
  /** Why there is no text, in Hubble's words. */
  problem?: string;
  contentHash?: string;
  capture?: ConversationCaptureMethod;
  messages: ConversationMessage[];
  /** A conversation kept as one block (no speaker labels). */
  text?: string;
  /** The store cut it to its bound. */
  truncated?: boolean;
};

export type Intent =
  | "research"
  | "learning"
  | "problem-solving"
  | "software-development"
  | "planning"
  | "writing"
  | "analysis"
  | "brainstorming"
  | "decision-making"
  | "troubleshooting";

export const INTENTS: readonly Intent[] = [
  "research",
  "learning",
  "problem-solving",
  "software-development",
  "planning",
  "writing",
  "analysis",
  "brainstorming",
  "decision-making",
  "troubleshooting",
];

export const INTENT_LABEL: Record<Intent, string> = {
  research: "Research",
  learning: "Learning",
  "problem-solving": "Problem-solving",
  "software-development": "Software development",
  planning: "Planning",
  writing: "Writing",
  analysis: "Analysis",
  brainstorming: "Brainstorming",
  "decision-making": "Decision-making",
  troubleshooting: "Troubleshooting",
};

export type IntentReading = {
  /** Absent when the conversation gives too little to say. */
  primary?: Intent;
  secondary?: Intent;
  /** 0..1 */
  confidence: number;
};

/** A message that supports something Hubble extracted. */
export type Evidence = {
  recordId: string;
  messageIndex: number;
  role: ConversationRole;
  /** The words, as saved, cut to a readable length. */
  quote: string;
};

export type FactKind = "decision" | "task" | "knowledge" | "question";

/**
 * Who a statement belongs to. The distinction the whole layer exists to keep:
 *
 *   user          the person said it
 *   assistant     the AI said it — a suggestion, an explanation, never a decision
 *   user-accepted the AI suggested it and the person then agreed, in words
 */
export type Attribution = "user" | "assistant" | "user-accepted";

export type DecisionStatus = "decided" | "accepted" | "suggested" | "considered" | "rejected";
export type TaskStatus = "committed" | "suggested" | "done";
export type KnowledgeStatus = "confirmed" | "unconfirmed";
export type QuestionStatus = "unresolved";
export type FactStatus = DecisionStatus | TaskStatus | KnowledgeStatus | QuestionStatus;

export type KnowledgeKind = "fix" | "finding" | "explanation" | "reference";

/** Which fixed pattern produced a fact — so "why does Hubble think this?" always has an answer. */
export type FactRule =
  | "user-decided"
  | "user-accepted"
  | "user-considered"
  | "user-rejected"
  | "user-turned-down"
  | "user-committed"
  | "user-reported-done"
  | "done-later"
  | "user-finding"
  | "user-said-it-worked"
  | "user-left-open"
  | "question-unanswered"
  | "question-did-not-work"
  | "ai-recommended"
  | "ai-next-step"
  | "ai-answered"
  | "ai-linked";

export const FACT_RULE_REASON: Record<FactRule, string> = {
  "user-decided": "Your own message states a decision (“let's use…”, “we decided…”).",
  "user-accepted": "The AI suggested it, and your next message agreed to that suggestion.",
  "user-considered": "You weighed it (“I'm thinking about…”) and the conversation never settled it.",
  "user-rejected": "Your own message rules it out (“let's not…”).",
  "user-turned-down": "The AI suggested it, and your next message turned it down.",
  "user-committed": "Your own message says you will do it (“I need to…”, “I'll…”).",
  "user-reported-done": "Your own message says it is done.",
  "done-later": "You said you'd do it, and a later message says it is done.",
  "user-finding": "Your own message reports what you found.",
  "user-said-it-worked": "The AI proposed it, and your next message said it worked.",
  "user-left-open": "Your own message leaves it open.",
  "question-unanswered": "You asked it last, and nothing came back.",
  "question-did-not-work": "You asked it, and then said the answer did not work.",
  "ai-recommended": "The AI's reply recommends it. It is only a suggestion until you agree.",
  "ai-next-step": "The AI listed it as a next step.",
  "ai-answered": "The AI's answer to your question. You haven't confirmed it.",
  "ai-linked": "An address the AI gave.",
};

export type Fact = {
  /** `<record id>:<kind>:<hash of the statement>` — stable for the same statement in the same conversation. */
  id: string;
  recordId: string;
  kind: FactKind;
  status: FactStatus;
  attribution: Attribution;
  /** The pattern that found it; see FACT_RULE_REASON. */
  rule: FactRule;
  /** The statement, as said (cleaned and cut), never paraphrased into something it did not say. */
  text: string;
  /** Stemmed topic words of the statement, for matching across conversations. */
  terms: string[];
  /** Lexicon entities the statement names — what a decision chose. */
  entities: string[];
  /** 0..1, from the pattern that found it — not a probability. */
  confidence: number;
  evidence: Evidence[];
  knowledgeKind?: KnowledgeKind;
  /** A decision that says what it replaces ("… instead of Postgres"). */
  replaces?: string;
  /** Why a question is open. */
  openReason?: "unanswered" | "did-not-work" | "left-open";
  /** When it was said, when the message carries a time. */
  at?: number;
  /** The person corrected or confirmed it — no longer only Hubble's reading. */
  corrected?: boolean;
  /** A later decision (or the person's later choice) replaced this one; it stays as history. */
  supersededBy?: string;
};

export type ExtractedEntity = {
  /** Lexicon id, or `x:<folded name>` for one found in the text. */
  id: string;
  name: string;
  kind: EntityKind;
  mentions: number;
  firstMessage: number;
  /** On the lexicon (certain), or a recurring name in the text (likely). */
  confidence: number;
};

export type ConversationExtraction = {
  recordId: string;
  contentHash: string;
  /** recordFingerprint() of what was read — the cache's test for "unchanged". */
  fingerprint: string;
  version: number;
  /** Stemmed topic word → weight, before cross-conversation weighting. */
  terms: Record<string, number>;
  /** Stemmed word → how the conversation spelled it. */
  spelling: Record<string, string>;
  entities: ExtractedEntity[];
  intent: IntentReading;
  facts: Fact[];
  /** Characters read; past the analysis bound the rest is counted, not read. */
  analyzedChars: number;
  truncated: boolean;
};

export type Topic = { term: string; label: string; weight: number };

/** One thing many conversations name, resolved across spellings. */
export type ResolvedEntity = {
  id: string;
  name: string;
  kind: EntityKind;
  recordIds: string[];
  mentions: number;
  confidence: number;
  /** Other spellings merged into it, and how sure that merge is. */
  merged?: { name: string; confidence: number }[];
};

/**
 * How two conversations relate, strongest first. Only "same-problem" forms
 * threads; "shared-entity" is a name in common and nothing more.
 */
export type RelationLevel = "same-problem" | "same-project" | "related-topic" | "shared-entity";

export const RELATION_LEVEL_LABEL: Record<RelationLevel, string> = {
  "same-problem": "Same problem",
  "same-project": "Same project",
  "related-topic": "Related topic",
  "shared-entity": "Shared name only",
};

export type Relation = {
  a: string;
  b: string;
  /** 0..1, for ordering and confidence: words, meaning, project and time together. */
  score: number;
  level: RelationLevel;
  /** Words-and-names evidence alone, 0..1 (0 when below the evidence gate). */
  lexical: number;
  /** Meaning (cosine of the two conversations' embeddings), when both have one. */
  semantic?: number;
  sharedTerms: string[];
  sharedEntities: string[];
  /** Project names both conversations mention. */
  sharedProjects: string[];
  sameWorkspace?: boolean;
  /** The person said these are related. */
  confirmed?: boolean;
  /** Every reason, in words — the answer to "why does Hubble think these are related?" */
  reasons: string[];
  /** Same conversation saved into two projects — not a relationship, an identity. */
  sameConversation?: boolean;
};

/** Two conversations with some evidence of a link that fell short of one. */
export type NearMiss = Pick<Relation, "a" | "b" | "lexical" | "semantic" | "sharedTerms" | "sharedEntities">;

export type ContradictionKind = "changed-decision" | "rejected-suggestion" | "providers-disagree";

export type Contradiction = {
  id: string;
  kind: ContradictionKind;
  /** The earlier and the later statement. */
  earlier: Fact;
  later: Fact;
  reason: string;
  confidence: number;
  /** Which side is the current state: the later one, or nobody's yet (two AIs disagree and the person hasn't settled it). */
  current: "later" | "undecided";
};

/** Conversations — possibly in different AI apps and projects — about one objective. */
export type ConversationThread = {
  id: string;
  label: string;
  recordIds: string[];
  providers: AiProviderId[];
  workspaceIds: string[];
  terms: string[];
  confidence: number;
  startedAt: number;
  updatedAt: number;
};

export type MemoryCategory = "working" | "project" | "long-term" | "episodic";

export type Memory = {
  id: string;
  category: MemoryCategory;
  text: string;
  /** Who it rests on. */
  attribution: Attribution;
  workspaceIds: string[];
  recordIds: string[];
  evidence: Evidence[];
  confidence: number;
  /** Confidence × recency × corroboration, for ordering. */
  relevance: number;
  /** A newer conversation appears to disagree with it. */
  conflict?: boolean;
  /** Working memory goes stale: past this, it is shown as needing a look, not as current. */
  revalidateAfter?: number;
  /** The person confirmed it. */
  confirmed?: boolean;
  /** A later decision replaced it: kept as history, ranked below what is current. */
  superseded?: boolean;
  at: number;
};

export type InsightKind = "related-work" | "inconsistency" | "unfinished" | "knowledge-gap" | "progress";

export type Insight = {
  id: string;
  kind: InsightKind;
  title: string;
  /** Why Hubble is showing it, in a sentence. */
  why: string;
  recordIds: string[];
  evidence: Evidence[];
  confidence: number;
  /** What the person might do — Hubble never does it for them. */
  suggestion: string;
  threadId?: string;
  at: number;
};

export type ConversationIndex = {
  records: ConversationRecord[];
  extractions: ReadonlyMap<string, ConversationExtraction>;
  topics: ReadonlyMap<string, Topic[]>;
  entities: ResolvedEntity[];
  relations: Relation[];
  nearMisses: NearMiss[];
  threads: ConversationThread[];
  /** Facts after corrections and cross-conversation status (a task done in a later chat is done). */
  facts: Fact[];
  contradictions: Contradiction[];
  memories: Memory[];
  insights: Insight[];
  processing: ReadonlyMap<string, ProcessingState>;
  /** Whether meaning-level (embedding) evidence took part, and for how many conversations. */
  semantic: { used: boolean; embedded: number };
};

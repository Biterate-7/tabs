import { cleanLine } from "@/lib/conversations/clean";
import { contentHash } from "@/lib/conversations/hash";
import { textTerms } from "@/lib/intelligence/features";
import { recordFingerprint } from "./canonical";
import { compiledLexicon, foldName } from "./lexicon";
import { EXTRACTOR_VERSION, INTENTS } from "./types";
import type { ConversationRole } from "@/lib/resources/types";
import type { EntityKind } from "./lexicon";
import type {
  Attribution,
  ConversationExtraction,
  ConversationMessage,
  ConversationRecord,
  Evidence,
  ExtractedEntity,
  Fact,
  FactKind,
  FactRule,
  FactStatus,
  Intent,
  IntentReading,
} from "./types";

/**
 * What one conversation says — read on the device, with fixed patterns, from
 * the text Hubble saved. Pure: the same record always gives the same result.
 *
 * ## Who said it decides what it is
 *
 * A statement's speaker is the turn's role, as the provider's page or export
 * recorded it. An AI turn that says "I decided to use Postgres" is still the
 * AI talking; it can only ever produce a *suggestion*. A person's decision
 * needs the person's own words:
 *
 *   decided     the person said they chose ("let's use", "I'll go with", "we decided")
 *   accepted    the AI suggested it and the person's next message agreed
 *               ("yes, let's do that", "go with option 2")
 *   suggested   the AI recommended it; nothing the person said confirmed it
 *   considered  the person weighed it ("I'm thinking about…", "should I…?")
 *               and never confirmed it in this conversation
 *   rejected    the person turned it down ("let's not", "no, …")
 *
 * Tasks keep the same line: a person's "I need to…" is a commitment; an AI's
 * "Next steps" are suggestions. A question is open only when the
 * conversation shows it: it was the last thing said, or the person came back
 * with "still not working" and nothing later says it worked. Asking a
 * question is not, by itself, leaving it unresolved.
 *
 * ## Bounded
 *
 * Long conversations are read up to `ANALYSIS_LIMITS`; the rest is counted,
 * not read, and the extraction says it was cut.
 */

export const ANALYSIS_LIMITS = {
  /** Characters read from one message. */
  messageChars: 20_000,
  /** Characters read from one conversation. */
  totalChars: 300_000,
  decisions: 30,
  tasks: 30,
  knowledge: 20,
  questions: 15,
  quote: 240,
} as const;

// ── Patterns ────────────────────────────────────────────────────────────────

const ACTIONS = "add|build|implement|write|fix|update|finish|create|set up|setup|deploy|test|refactor|migrate|move|check|review|clean up|document|ship|send|read|start|make|try|look into|rewrite|draft|submit|book|email|call|prepare|learn|study";
const CHOICE = "go with|use|stick with|switch to|pick|choose|keep|adopt|move to";

const USER_DECIDED = new RegExp(
  [
    String.raw`\b(?:i|we)(?:'ve| have)? (?:decided|settled)\b`,
    String.raw`\b(?:i|we)(?:'m| am|'re| are) (?:going|gonna) (?:to )?(?:${CHOICE})\b`,
    String.raw`\b(?:i|we)(?:'ll| will) (?:${CHOICE})\b`,
    String.raw`\blet'?s (?:${CHOICE})\b`,
    String.raw`\b(?:i|we) (?:chose|picked|went with|settled on|switched to|opted for)\b`,
    String.raw`\b(?:i|we)(?:'ve| have) (?:chosen|picked|settled on|switched to|gone with|opted for)\b`,
    String.raw`^(?:decision|decided|final decision)\s*[:-]`,
  ].join("|"),
  "i"
);
const USER_REJECTED = /\b(?:i|we) (?:won'?t|will not|don'?t want to|do not want to|decided not to|chose not to|aren'?t going to|am not going to) (?:use|go with|do|pick|choose|keep|switch)\b|\blet'?s not\b|\b(?:i|we)(?:'re| are|'m| am) (?:dropping|scrapping|abandoning|not using|not going with)\b|\bscrap (?:that|the|this)\b/i;
const USER_CONSIDERED = /\b(?:i|we)(?:'m| am|'re| are) (?:thinking (?:about|of)|considering|leaning (?:towards?|toward))\b|\bmaybe (?:i|we) (?:should|could|will)\b|\b(?:i|we) might (?:use|go with|switch|try|pick)\b|\bshould (?:i|we) (?:use|go with|switch to|pick|choose|keep)\b|\b(?:not sure|unsure) (?:if|whether|which)\b|\bwhich (?:one )?should (?:i|we)\b/i;
const AI_SUGGESTS = /\b(?:i(?:'d| would) (?:recommend|suggest|go with)|i (?:recommend|suggest)|my recommendation|you (?:should|could|might want to|may want to) (?:use|try|switch|consider|go with|add|move|start|keep|avoid|pick)|consider (?:using|switching|adding|moving)|the (?:best|simplest|cleanest|recommended|right) (?:option|approach|choice|way|fix|solution) (?:is|would be|here is)|a (?:better|good|simpler) (?:approach|option|choice|way) (?:is|would be))\b|^recommend(?:ed|ation)\s*[:-]/i;
const ACCEPTS = /^(?:yes|yep|yeah|ok(?:ay)?|sure|sounds good|perfect|great|agreed|alright|cool|nice|deal)\b|^(?:let'?s|i'?ll|we'?ll) (?:do|go with|use|try|take) (?:that|it|this|those|your|option|the|approach)\b|^(?:go with|do) (?:that|it|this|option)\b|^that (?:works|sounds (?:good|right|great))\b|^i like (?:that|this|the|your|option)\b/i;
const REJECTS_AI = /^(?:no|nope|nah)\b|^i don'?t (?:like|want|think so)\b|^that (?:won'?t|doesn'?t|wouldn'?t) work\b|^not (?:that|this)\b/i;
const OPTION_NUMBER = /\b(?:option|approach|number|choice|#)\s*(\d+)\b|\b(first|second|third|fourth|1st|2nd|3rd|4th)\b/i;
const ORDINAL: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };

const USER_COMMITS = new RegExp(
  [
    String.raw`\b(?:i|we) (?:still )?(?:need|have) to (?:${ACTIONS})\b`,
    String.raw`\b(?:i|we)(?:'ll| will) (?:need to |have to |also |then |now |later |tomorrow |first )?(?:${ACTIONS})\b`,
    String.raw`\b(?:i|we)(?:'m| am|'re| are) going to (?:${ACTIONS})\b`,
    String.raw`^(?:todo|to-do|to do|next step|next steps|action item)\s*[:-]`,
    String.raw`\bremind me to\b`,
    String.raw`\bnext,? (?:i|we)(?:'ll| will)\b`,
  ].join("|"),
  "i"
);
const AI_NEXT_HEADER = /^(?:#+\s*)?(?:\*\*)?(?:next steps?|what to do next|action items|to-?do|recommended steps|follow[- ]?ups?)\b/i;
const AI_NEXT = /\b(?:next,? you(?:'ll| will| should| can)|the next step (?:is|would be)|as a next step|once that(?:'s| is) done,? you)\b/i;
const DONE = /\b(?:i|we)(?:'ve| have)? (?:done|finished|completed|implemented|fixed|deployed|shipped|set up|migrated|resolved|submitted|sent)\b|\b(?:it|that|this) (?:worked|works now|fixed it|did the trick)\b|\bworks now\b|^(?:done|finished|all done)\b|\bproblem solved\b/i;

const FAILED = /\b(?:still (?:not|doesn'?t|isn'?t|getting|failing|broken|the same|seeing|happening|an? (?:error|issue))|didn'?t (?:work|help|fix)|doesn'?t (?:work|help|fix)|not working|same (?:error|issue|problem)|(?:error|issue|problem) (?:persists|is still there))\b/i;
const SUCCESS = /\b(?:that|it|this) (?:worked|works|fixed it|did the trick|helped|solved it)\b|\bworks now\b|\bproblem solved\b|^(?:thanks|thank you|perfect|great)[,!. ]*(?:that|it|this)? ?(?:worked|works|helped|makes sense|fixed it)?[.!]*$|^fixed[.!]/i;
const LEFT_OPEN = /\bopen question\b|\b(?:i|we)(?:'ll| will) (?:need to )?(?:figure|look into|check|come back to) (?:this|that|it) (?:out )?later\b|\bstill (?:unsure|not sure|undecided)\b|\bhaven'?t (?:decided|figured (?:it|this|that) out)\b/i;
const USER_FINDING = /\b(?:i|we) (?:found|learned|realized|realised|noticed|discovered|figured out)\b|\bturns out\b|\bthe (?:issue|problem|cause|bug|root cause) (?:is|was)\b/i;
const QUESTION_START = /^(?:what|why|how|explain|can you explain|what'?s|tell me about|describe|what is the difference|difference between|is it true)/i;
const DEFINITION = /^[A-Za-z][\w .+#/-]{1,40}? (?:is|are|refers to|means) (?:a|an|the|when|how|basically|essentially)\b/;
const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;
const FILE = /\b[\w-]+(?:\/[\w.-]+)*\.(?:pdf|docx?|md|csv|xlsx?|json|ts|tsx|js|jsx|py|rs|go|sql|ya?ml|toml|ipynb)\b/g;

const INTENT_SIGNALS: Record<Intent, RegExp> = {
  research: /\b(?:research|compare|comparison|sources?|studies|study shows|evidence|literature|papers?|what are the best|pros and cons|survey of|state of the art|benchmark)\b/i,
  learning: /\b(?:explain|what is|what are|how does|how do .+ work|teach me|understand|eli5|difference between|why does|why is|intuition|concept of|learn)\b/i,
  "problem-solving": /\b(?:how (?:do|can|should) i|solve|solution|approach (?:to|for)|work ?around|figure out|best way to)\b/i,
  "software-development": /\b(?:implement|function|component|api|endpoint|refactor|deploy|repo|codebase|class|module|typescript|python|schema|migration|frontend|backend|database|build)\b/i,
  planning: /\b(?:plan|roadmap|schedule|timeline|milestones?|itinerary|strategy|steps to|prioriti[sz]e|week by week|by (?:monday|friday|next week))\b/i,
  writing: /\b(?:write|draft|rewrite|reword|essay|email|letter|blog post|proofread|edit my|paragraph|cover letter|tone|summary of my)\b/i,
  analysis: /\b(?:analy[sz]e|analysis|dataset|metrics|evaluate|assess|statistics|correlation|trend|chart|regression|numbers)\b/i,
  brainstorming: /\b(?:ideas?|brainstorm|names? for|suggest some|what could|alternatives|creative|come up with|possible directions)\b/i,
  "decision-making": /\b(?:should i|which (?:one|option|is better)|or should|versus|vs\.?|choose between|decide|trade-?offs?|worth it)\b/i,
  troubleshooting: /\b(?:error|exception|traceback|stack trace|bug|broken|fails?|failing|crash(?:es|ed)?|doesn'?t work|not working|undefined is not|cannot find|unexpected)\b/i,
};

/** What any chat says whatever it is about: never a topic. */
const CHAT_WORDS = new Set(
  [
    "please", "thank", "thanks", "okay", "yes", "yeah", "hello", "sure", "want", "like", "make", "use", "using", "need", "get", "also", "just", "would", "could",
    "should", "can", "done", "read", "tell", "explain", "help", "let", "try", "tried", "think", "thinking", "know", "sound", "great", "good", "right", "way", "still",
    "now", "here", "give", "show", "write", "question", "answer", "example", "sense", "work", "thing", "after", "before", "next", "then", "first", "seem", "seems",
    "keep", "decide", "decided", "decision", "moving", "move", "both", "either", "must", "put", "happen", "happens", "usually", "turn", "add", "update", "tomorrow",
    "today", "option", "options", "approach", "choice", "choose", "better", "best", "simple", "simply", "really", "actually", "maybe", "might", "going", "start",
    "since", "because", "instead", "while", "until", "again", "another", "other", "some", "many", "much", "every", "each", "same", "different", "new", "old",
  ].map((word) => topicStemOf(word))
);

function topicStemOf(word: string): string {
  return textTerms(word).words[0] ?? word;
}

// ── Text helpers ────────────────────────────────────────────────────────────

type Sentence = { text: string; listItem: boolean; header: boolean; underNextSteps: boolean; position: number };
type Read = { prose: string; code: string; sentences: Sentence[] };

function stripMarkup(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|(?:[-*•]|\d+[.)])\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/** A message's prose (code fences left out), its code, and its sentences. */
function readMessage(text: string): Read {
  const prose: string[] = [];
  const code: string[] = [];
  const sentences: Sentence[] = [];
  let inFence = false;
  let underNextSteps = false;
  let position = 0;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      code.push(raw);
      continue;
    }
    prose.push(raw);
    if (!raw.trim()) continue;
    const listItem = /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(raw);
    const header = /^\s*#{1,6}\s/.test(raw) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(raw) || /:\s*$/.test(raw.trim());
    const line = stripMarkup(raw);
    if (!line) continue;
    if (header) underNextSteps = AI_NEXT_HEADER.test(line.split(/(?<=[.!?])\s+/).pop() ?? line);
    else if (!listItem && underNextSteps && !AI_NEXT_HEADER.test(line)) underNextSteps = false;
    const parts = listItem || header ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) sentences.push({ text: sentence, listItem, header, underNextSteps: underNextSteps && listItem, position: position++ });
    }
  }
  return { prose: prose.join("\n"), code: code.join("\n"), sentences };
}

function quoteOf(text: string): string {
  return cleanLine(text, ANALYSIS_LIMITS.quote);
}

function termsOf(text: string): string[] {
  return [...new Set(textTerms(text).words)];
}

function isQuestion(sentence: string): boolean {
  return /\?\s*["”)]?$/.test(sentence);
}

function shared(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  let count = 0;
  for (const term of b) if (set.has(term)) count += 1;
  return count;
}

// ── Entities ────────────────────────────────────────────────────────────────

const CAPITALISED = /\b([A-Z][a-z0-9]+(?:[ -][A-Z][a-z0-9]+){1,3})\b/g;
const PROJECT_NAMED = /\b(?:project|app|repo|product|startup|company|codebase|tool) (?:called|named) ["“']?([A-Z][\w-]+(?: [A-Z][\w-]+)?)/g;
const PROJECT_SUFFIX = /\b([A-Z][\w-]{2,}) (?:project|app|repo|codebase)\b/g;
const NOT_A_NAME = new Set(["the", "this", "that", "these", "those", "you", "your", "i", "we", "step", "option", "note", "example", "here", "yes", "no", "next", "first", "then", "also", "if", "when", "for", "and", "but", "my", "it", "in", "on", "to", "a", "an", "of", "so", "ok", "okay", "thanks", "sure"]);

function entityMatches(text: string, inCode: boolean, found: Map<string, { name: string; kind: EntityKind; mentions: number; first: number; confidence: number }>, messageIndex: number) {
  for (const { entry, pattern, ambiguous } of compiledLexicon()) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const word = match[0];
      if (ambiguous.has(word.toLowerCase())) {
        const lead = text.slice(Math.max(0, match.index - 3), match.index);
        const sentenceStart = match.index === 0 || /[.!?:\n]\s*$/.test(lead);
        const named = /^[A-Z]/.test(word) && !sentenceStart;
        const ticked = text.charAt(match.index - 1) === "`";
        if (!inCode && !named && !ticked) continue;
        if (inCode && !/^[A-Za-z]/.test(word)) continue;
      }
      const current = found.get(entry.id);
      if (current) current.mentions += 1;
      else found.set(entry.id, { name: entry.name, kind: entry.kind, mentions: 1, first: messageIndex, confidence: 1 });
    }
  }
}

let aliasSet: Set<string> | undefined;
function lexiconAliases(): ReadonlySet<string> {
  aliasSet ??= new Set(compiledLexicon().flatMap(({ entry }) => entry.aliases.map((alias) => alias.toLowerCase())));
  return aliasSet;
}

function freeEntities(sentences: readonly Sentence[], messageIndex: number, counts: Map<string, { name: string; kind: EntityKind; mentions: number; first: number }>) {
  const aliases = lexiconAliases();
  for (const sentence of sentences) {
    const text = sentence.text;
    const add = (name: string, kind: EntityKind) => {
      const folded = foldName(name);
      const words = folded.split(" ");
      if (words.every((word) => NOT_A_NAME.has(word) || aliases.has(word))) return;
      if (aliases.has(folded)) return;
      const id = `x:${folded}`;
      const current = counts.get(id);
      if (current) {
        current.mentions += 1;
        if (kind === "project") current.kind = "project";
      } else counts.set(id, { name: name.trim(), kind, mentions: 1, first: messageIndex });
    };
    for (const pattern of [PROJECT_NAMED, PROJECT_SUFFIX]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) add(match[1]!, "project");
    }
    CAPITALISED.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CAPITALISED.exec(text))) {
      // A capital at the start of a sentence says nothing about a name.
      if (match.index === 0) continue;
      const first = match[1]!.split(/[ -]/)[0]!.toLowerCase();
      if (NOT_A_NAME.has(first)) continue;
      add(match[1]!, "concept");
    }
  }
}

function resourceEntities(text: string, messageIndex: number, found: Map<string, { name: string; kind: EntityKind; mentions: number; first: number; confidence: number }>) {
  for (const raw of text.match(URL_PATTERN) ?? []) {
    let name: string;
    try {
      const url = new URL(raw.replace(/[.,;:!?]+$/, ""));
      // The address without its query or fragment: a query can carry a secret.
      name = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120);
    } catch {
      continue;
    }
    const id = `u:${name.toLowerCase()}`;
    const current = found.get(id);
    if (current) current.mentions += 1;
    else found.set(id, { name, kind: "resource", mentions: 1, first: messageIndex, confidence: 1 });
  }
  for (const name of text.match(FILE) ?? []) {
    // "Next.js" and "Node.js" are names, not files.
    if (lexiconAliases().has(name.toLowerCase())) continue;
    const id = `f:${name.toLowerCase()}`;
    const current = found.get(id);
    if (current) current.mentions += 1;
    else found.set(id, { name, kind: "resource", mentions: 1, first: messageIndex, confidence: 0.9 });
  }
}

/** Lexicon entity ids a sentence names (for what a decision chose). */
export function lexiconIdsIn(text: string): string[] {
  const found = new Map<string, { name: string; kind: EntityKind; mentions: number; first: number; confidence: number }>();
  entityMatches(text, false, found, 0);
  return [...found.keys()].sort();
}

// ── Intent ──────────────────────────────────────────────────────────────────

function readIntent(user: { text: string; first: boolean }[], hasCode: boolean, entities: readonly ExtractedEntity[], decisions: number): IntentReading {
  const scores = new Map<Intent, number>(INTENTS.map((intent) => [intent, 0]));
  const bump = (intent: Intent, value: number) => scores.set(intent, (scores.get(intent) ?? 0) + value);
  for (const turn of user) {
    // The first message usually states the goal; later ones follow it.
    const weight = turn.first ? 2 : 1;
    for (const intent of INTENTS) {
      const pattern = new RegExp(INTENT_SIGNALS[intent].source, "gi");
      const hits = Math.min(3, (turn.text.match(pattern) ?? []).length);
      if (hits > 0) bump(intent, weight * (1 + 0.25 * (hits - 1)));
    }
  }
  if (hasCode) bump("software-development", 1.5);
  const technical = entities.filter((entity) => entity.kind === "language" || entity.kind === "framework" || entity.kind === "tool").length;
  if (technical > 0) bump("software-development", Math.min(2, technical * 0.5));
  if (decisions > 0) bump("decision-making", Math.min(2, decisions * 0.75));
  // Troubleshooting is development's narrower case: a code chat with errors is troubleshooting first.
  if ((scores.get("troubleshooting") ?? 0) >= 2 && hasCode) bump("troubleshooting", 1);

  const ranked = [...scores.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || INTENTS.indexOf(a[0]) - INTENTS.indexOf(b[0]));
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const [top, second] = ranked;
  if (!top || top[1] < 1.5) return { confidence: 0 };
  const confidence = Math.round(Math.min(1, (top[1] / total) * Math.min(1, total / 4) + 0.25) * 100) / 100;
  return {
    primary: top[0],
    ...(second && second[1] >= Math.max(1, top[1] * 0.5) ? { secondary: second[0] } : {}),
    confidence,
  };
}

// ── Facts ───────────────────────────────────────────────────────────────────

type Draft = Omit<Fact, "id" | "recordId" | "terms" | "entities"> & { terms?: string[] };

function evidenceOf(record: ConversationRecord, message: ConversationMessage, quote: string): Evidence {
  return { recordId: record.id, messageIndex: message.index, role: message.role, quote: quoteOf(quote) };
}

/**
 * Everything one conversation says, extracted. Excluded, empty and
 * text-only conversations still get an extraction — with no turns there are
 * no speakers, so no decisions, tasks or questions are claimed for one.
 */
export function extractConversation(record: ConversationRecord): ConversationExtraction {
  let budget: number = ANALYSIS_LIMITS.totalChars;
  let truncated = record.truncated === true;
  const reads: { message: ConversationMessage; read: Read }[] = [];
  for (const message of record.messages) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const slice = message.text.slice(0, Math.min(ANALYSIS_LIMITS.messageChars, budget));
    if (slice.length < message.text.length) truncated = true;
    budget -= slice.length;
    reads.push({ message, read: readMessage(slice) });
  }
  const blockText = record.messages.length === 0 && record.text ? record.text.slice(0, ANALYSIS_LIMITS.totalChars) : "";
  if (record.text && record.text.length > ANALYSIS_LIMITS.totalChars) truncated = true;

  // Topic words: the person's words count more than the AI's, which restate and pad.
  const terms = new Map<string, number>();
  const spelling: Record<string, string> = {};
  const addTerms = (text: string, weight: number) => {
    // Addresses are entities, read without their query; their words are never topics.
    const read = textTerms(text.replace(URL_PATTERN, " "));
    for (const word of read.words) if (!CHAT_WORDS.has(word)) terms.set(word, (terms.get(word) ?? 0) + weight);
    for (const [word, raw] of read.spelling) if (!(word in spelling)) spelling[word] = raw;
  };
  addTerms(record.title, 3);
  for (const { message, read } of reads) addTerms(read.prose, message.role === "user" ? 1.5 : 0.5);
  if (blockText) addTerms(readMessage(blockText).prose, 1);

  // Entities.
  const lexical = new Map<string, { name: string; kind: EntityKind; mentions: number; first: number; confidence: number }>();
  const free = new Map<string, { name: string; kind: EntityKind; mentions: number; first: number }>();
  entityMatches(record.title, false, lexical, 0);
  for (const { message, read } of reads) {
    entityMatches(read.prose, false, lexical, message.index);
    if (read.code) entityMatches(read.code, true, lexical, message.index);
    for (const language of message.codeLanguages ?? []) entityMatches(language, true, lexical, message.index);
    resourceEntities(read.prose, message.index, lexical);
    freeEntities(read.sentences, message.index, free);
  }
  if (blockText) {
    const read = readMessage(blockText);
    entityMatches(read.prose, false, lexical, 0);
    resourceEntities(read.prose, 0, lexical);
    freeEntities(read.sentences, 0, free);
  }
  const entities: ExtractedEntity[] = [
    ...[...lexical.entries()].map(([id, entry]) => ({ id, name: entry.name, kind: entry.kind, mentions: entry.mentions, firstMessage: entry.first, confidence: entry.confidence })),
    // A name the text repeats is likely a thing; once is a capital letter.
    ...[...free.entries()]
      .filter(([, entry]) => entry.mentions >= 2 || entry.kind === "project")
      .map(([id, entry]) => ({ id, name: entry.name, kind: entry.kind, mentions: entry.mentions, firstMessage: entry.first, confidence: entry.kind === "project" ? 0.65 : 0.5 })),
  ].sort((a, b) => b.mentions - a.mentions || (a.id < b.id ? -1 : 1));

  const facts = extractFacts(record, reads);
  const user = reads.filter(({ message }) => message.role === "user").map(({ read }, index) => ({ text: read.prose, first: index === 0 }));
  if (blockText) user.push({ text: blockText, first: true });
  const hasCode = reads.some(({ read }) => read.code.trim().length > 0);
  const intent = readIntent(user, hasCode, entities, facts.filter((fact) => fact.kind === "decision" && (fact.status === "decided" || fact.status === "accepted")).length);

  const analyzedChars = ANALYSIS_LIMITS.totalChars - budget + blockText.length;
  return {
    recordId: record.id,
    contentHash: record.contentHash ?? contentHash({ turns: record.messages.map((message) => ({ role: message.role, text: message.text })), ...(record.text ? { text: record.text } : {}) }),
    fingerprint: recordFingerprint(record),
    version: EXTRACTOR_VERSION,
    terms: Object.fromEntries([...terms.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 200)),
    spelling,
    entities,
    intent,
    facts,
    analyzedChars,
    truncated,
  };
}

function extractFacts(record: ConversationRecord, reads: readonly { message: ConversationMessage; read: Read }[]): Fact[] {
  const drafts: Draft[] = [];
  const limits: Record<FactKind, number> = { decision: ANALYSIS_LIMITS.decisions, task: ANALYSIS_LIMITS.tasks, knowledge: ANALYSIS_LIMITS.knowledge, question: ANALYSIS_LIMITS.questions };
  const counts: Record<FactKind, number> = { decision: 0, task: 0, knowledge: 0, question: 0 };
  const push = (draft: Draft) => {
    if (counts[draft.kind] >= limits[draft.kind]) return undefined;
    counts[draft.kind] += 1;
    drafts.push(draft);
    return draft;
  };
  const make = (kind: FactKind, status: FactStatus, attribution: Attribution, rule: FactRule, text: string, confidence: number, evidence: Evidence[], extra: Partial<Draft> = {}): Draft => ({
    kind,
    status,
    attribution,
    rule,
    text: quoteOf(text),
    confidence,
    evidence,
    ...(evidence[0] && record.messages[evidence[0].messageIndex]?.at !== undefined ? { at: record.messages[evidence[0].messageIndex]!.at } : {}),
    ...extra,
  });

  // The AI's suggestions in its most recent turn, and its listed options: what the person's next message can accept or turn down.
  let lastSuggestions: Draft[] = [];
  let lastOptions: { text: string; message: ConversationMessage }[] = [];
  let lastAssistant: { message: ConversationMessage; read: Read } | undefined;
  // Questions the person asked, waiting to see whether the conversation answered them.
  const pending: { draft: Draft; message: ConversationMessage; userTurn: number }[] = [];
  let userTurn = 0;

  for (const entry of reads) {
    const { message, read } = entry;
    if (message.role === "assistant") {
      lastSuggestions = [];
      lastOptions = [];
      let explained = false;
      const previousUser = reads[reads.indexOf(entry) - 1];
      const answersQuestion = previousUser?.message.role === "user" && QUESTION_START.test(previousUser.read.sentences[0]?.text ?? "");
      for (const sentence of read.sentences) {
        if (sentence.listItem && !sentence.underNextSteps) lastOptions.push({ text: sentence.text, message });
        if (sentence.underNextSteps || (AI_NEXT.test(sentence.text) && !isQuestion(sentence.text))) {
          push(make("task", "suggested", "assistant", "ai-next-step", sentence.text, 0.6, [evidenceOf(record, message, sentence.text)]));
          continue;
        }
        if (AI_SUGGESTS.test(sentence.text) && !isQuestion(sentence.text)) {
          const draft = push(make("decision", "suggested", "assistant", "ai-recommended", sentence.text, 0.65, [evidenceOf(record, message, sentence.text)]));
          if (draft) lastSuggestions.push(draft);
          continue;
        }
        if (answersQuestion && !explained && !sentence.header && sentence.text.split(/\s+/).length >= 6 && (DEFINITION.test(sentence.text) || sentence.position === 0)) {
          explained = true;
          push(make("knowledge", "unconfirmed", "assistant", "ai-answered", sentence.text, 0.5, [evidenceOf(record, message, sentence.text)], { knowledgeKind: "explanation" }));
        }
      }
      for (const raw of read.prose.match(URL_PATTERN) ?? []) {
        push(make("knowledge", "unconfirmed", "assistant", "ai-linked", raw.replace(/[.,;:!?]+$/, "").replace(/[?#].*$/, ""), 0.45, [evidenceOf(record, message, raw)], { knowledgeKind: "reference" }));
      }
      // An earlier question the AI has now replied to stays pending until the person says whether it helped.
      lastAssistant = entry;
      continue;
    }

    // The person's turn.
    userTurn += 1;
    const first = read.sentences[0]?.text ?? "";
    const whole = read.prose.trim();
    const short = whole.length <= 280;

    // Their verdict on the AI's last answer.
    if (lastAssistant && short && SUCCESS.test(whole) && !FAILED.test(whole)) {
      const solution = lastSuggestions[0]?.text ?? lastAssistant.read.sentences.find((sentence) => !sentence.header && sentence.text.split(/\s+/).length >= 5)?.text;
      if (solution) {
        push(make("knowledge", "confirmed", "user-accepted", "user-said-it-worked", solution, 0.75, [evidenceOf(record, lastAssistant.message, solution), evidenceOf(record, message, whole)], { knowledgeKind: "fix" }));
      }
      // What it answered is answered.
      pending.length = 0;
    }
    if (FAILED.test(whole)) {
      for (const item of pending) if (userTurn - item.userTurn <= 3) item.draft.openReason = "did-not-work";
    }

    // Accepting or turning down what the AI just suggested. The sentence that does it is that verdict, nothing more.
    let verdictGiven = false;
    if (lastAssistant && first) {
      const candidates = lastSuggestions.length > 0 ? lastSuggestions.map((draft) => ({ text: draft.text, draft })) : lastOptions.map((option) => ({ text: option.text, draft: undefined as Draft | undefined }));
      let chosen: { text: string; draft: Draft | undefined } | undefined;
      const numbered = OPTION_NUMBER.exec(first);
      if (numbered && lastOptions.length > 0) {
        const index = numbered[1] ? Number(numbered[1]) : ORDINAL[numbered[2]!.toLowerCase()]!;
        const option = lastOptions[index - 1];
        if (option) chosen = { text: option.text, draft: lastSuggestions.find((draft) => draft.text === quoteOf(option.text)) };
      }
      if (!chosen && candidates.length === 1) chosen = candidates[0];
      if (!chosen && candidates.length > 1) {
        const mine = termsOf(whole);
        const scored = candidates.map((candidate) => ({ candidate, overlap: shared(termsOf(candidate.text), mine) })).filter((entry) => entry.overlap > 0);
        // Only when one candidate clearly matches: "yes" to three ideas accepts none of them.
        if (scored.length === 1) chosen = scored[0]!.candidate;
      }
      if (chosen && (ACCEPTS.test(first) || (numbered && !REJECTS_AI.test(first) && /\b(?:go|use|take|do|let'?s|pick)\b/i.test(first)))) {
        const evidence = [evidenceOf(record, lastAssistant.message, chosen.text), evidenceOf(record, message, first)];
        if (chosen.draft) {
          chosen.draft.status = "accepted";
          chosen.draft.attribution = "user-accepted";
          chosen.draft.rule = "user-accepted";
          chosen.draft.confidence = 0.75;
          chosen.draft.evidence = evidence;
        } else {
          push(make("decision", "accepted", "user-accepted", "user-accepted", chosen.text, 0.7, evidence));
        }
        verdictGiven = true;
      } else if (chosen && REJECTS_AI.test(first)) {
        const evidence = [evidenceOf(record, lastAssistant.message, chosen.text), evidenceOf(record, message, first)];
        if (chosen.draft) {
          chosen.draft.status = "rejected";
          chosen.draft.attribution = "user";
          chosen.draft.rule = "user-turned-down";
          chosen.draft.evidence = evidence;
        } else {
          push(make("decision", "rejected", "user", "user-turned-down", chosen.text, 0.65, evidence));
        }
        verdictGiven = true;
      }
    }

    for (const sentence of read.sentences) {
      if (verdictGiven && sentence.position === 0) continue;
      const text = sentence.text;
      const question = isQuestion(text);
      if (USER_REJECTED.test(text) && !question) {
        push(make("decision", "rejected", "user", "user-rejected", text, 0.7, [evidenceOf(record, message, text)]));
        continue;
      }
      if (USER_DECIDED.test(text) && !question) {
        const instead = /\binstead of ([^.,;!?]+)/i.exec(text);
        push(make("decision", "decided", "user", "user-decided", text, 0.85, [evidenceOf(record, message, text)], instead ? { replaces: quoteOf(instead[1]!) } : {}));
        continue;
      }
      if (USER_CONSIDERED.test(text)) {
        push(make("decision", "considered", "user", "user-considered", text, 0.55, [evidenceOf(record, message, text)]));
        if (!question) continue;
      }
      if (USER_COMMITS.test(text) && !question) {
        push(make("task", "committed", "user", "user-committed", text, 0.75, [evidenceOf(record, message, text)]));
        continue;
      }
      if (DONE.test(text) && !question) {
        push(make("task", "done", "user", "user-reported-done", text, 0.7, [evidenceOf(record, message, text)]));
        continue;
      }
      if (USER_FINDING.test(text) && !question && text.split(/\s+/).length >= 5) {
        push(make("knowledge", "confirmed", "user", "user-finding", text, 0.7, [evidenceOf(record, message, text)], { knowledgeKind: "finding" }));
        continue;
      }
      if (LEFT_OPEN.test(text)) {
        push(make("question", "unresolved", "user", "user-left-open", text, 0.75, [evidenceOf(record, message, text)], { openReason: "left-open" }));
        continue;
      }
      if (question && text.split(/\s+/).length >= 3) {
        const draft = make("question", "unresolved", "user", "question-unanswered", text, 0.8, [evidenceOf(record, message, text)], { openReason: "unanswered" });
        pending.push({ draft, message, userTurn });
      }
    }
    lastAssistant = undefined;
    lastSuggestions = [];
  }

  // Which of the person's questions the conversation leaves open.
  const lastIndex = record.messages.length - 1;
  for (const item of pending) {
    if (item.draft.openReason === "did-not-work") {
      push({ ...item.draft, rule: "question-did-not-work", confidence: 0.7 });
    } else if (item.message.index === lastIndex) {
      // Asked last, and nothing came back.
      push(item.draft);
    }
  }

  // A plan the person weighed and then settled on is a decision, not an open consideration.
  const settled = drafts.filter((draft) => draft.kind === "decision" && (draft.status === "decided" || draft.status === "accepted"));
  const kept = drafts.filter((draft) => {
    if (draft.kind !== "decision" || draft.status !== "considered") return true;
    const mine = termsOf(draft.text);
    const at = draft.evidence[0]!.messageIndex;
    return !settled.some((decision) => decision.evidence[decision.evidence.length - 1]!.messageIndex >= at && shared(termsOf(decision.text), mine) >= 1);
  });

  // A commitment the same conversation later reports done is done.
  const doneSignals = kept.filter((draft) => draft.kind === "task" && draft.status === "done");
  for (const draft of kept) {
    if (draft.kind !== "task" || draft.status !== "committed") continue;
    const mine = termsOf(draft.text);
    const at = draft.evidence[0]!.messageIndex;
    const done = doneSignals.find((signal) => signal.evidence[0]!.messageIndex > at && shared(termsOf(signal.text), mine) >= 1);
    if (done) {
      draft.status = "done";
      draft.rule = "done-later";
      draft.evidence = [...draft.evidence, ...done.evidence];
    }
  }

  const seen = new Set<string>();
  const facts: Fact[] = [];
  for (const draft of kept) {
    const id = `${record.id}:${draft.kind}:${contentHash({ text: draft.text })}`;
    if (seen.has(id)) continue;
    seen.add(id);
    facts.push({ ...draft, id, recordId: record.id, terms: draft.terms ?? termsOf(draft.text), entities: lexiconIdsIn(draft.text) });
  }
  return facts;
}

/** Who a fact belongs to, in words: "You decided", "Claude suggested", "You accepted ChatGPT's suggestion". */
export function attributionLabel(fact: Pick<Fact, "kind" | "status" | "attribution">, ai: string): string {
  if (fact.kind === "decision") {
    if (fact.status === "decided") return "You decided";
    if (fact.status === "accepted") return `You accepted ${ai}'s suggestion`;
    if (fact.status === "suggested") return `${ai} suggested`;
    if (fact.status === "considered") return "You considered — not confirmed";
    return fact.attribution === "user" && fact.status === "rejected" ? "You turned this down" : "Rejected";
  }
  if (fact.kind === "task") return fact.status === "committed" ? "You said you'd do this" : fact.status === "done" ? "Done" : `${ai} suggested as a next step`;
  if (fact.kind === "knowledge") return fact.attribution === "user" ? "You found" : fact.attribution === "user-accepted" ? `${ai}'s answer — you said it worked` : `${ai} explained — unconfirmed`;
  return "Open question";
}

export function roleName(role: ConversationRole, ai: string): string {
  return role === "user" ? "You" : ai;
}


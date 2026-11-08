import { textTerms } from "@/lib/intelligence/features";
import { AI_PROVIDER_IDS, aiProviderName } from "@/lib/providers/registry";
import { lexiconIdsIn } from "./extract";
import { foldName } from "./lexicon";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationIndex, ConversationRecord, ConversationThread, Evidence, Fact } from "./types";

/**
 * Asking about saved conversations — "what did I decide about sync?", "which
 * questions are still open?", "what did Claude suggest that I later
 * discussed with ChatGPT?" — answered from the index, with every result
 * traced to the conversation and message it came from.
 *
 * ## How a question is read
 *
 * Fixed phrases, not a model: an AI app's name filters by app; "last week",
 * "yesterday", "in the last 30 days" filter by time; a project's name
 * filters by project; "decide", "open questions", "to do", "accomplished",
 * "suggest" choose what kind of answer. The words left over are the subject.
 *
 * ## How conversations are ranked
 *
 *   keyword    the subject's words in the title, the text, the topics
 *   entities   names in the question resolved like names in the text
 *              ("postgresql" finds a chat that said "Postgres")
 *   threads    conversations in the same thread as a strong match come along
 *              (they are about the same objective), marked as such
 *   time, app, project   filters, never scores
 *
 * There is no embedding model here: "semantic" reach comes from entity
 * resolution and threads, and the answer says what matched. When nothing
 * matches, the answer says so instead of offering the nearest thing.
 */

export type QueryFocus = "conversations" | "decisions" | "questions" | "tasks" | "accomplished" | "suggestions";

export type ParsedQuery = {
  text: string;
  /** Stemmed subject words. */
  terms: string[];
  /** Lexicon entities the question names. */
  entities: string[];
  providers: AiProviderId[];
  /** "… that I later discussed with ChatGPT": the app the suggestion was taken to. */
  laterProvider?: AiProviderId;
  since?: number;
  until?: number;
  timeLabel?: string;
  workspaceIds: string[];
  focus: QueryFocus;
};

const PROVIDER_WORDS: { pattern: RegExp; provider: AiProviderId }[] = [
  { pattern: /\b(?:chatgpt|chat gpt|gpt(?:-?\d\w*)?|openai)\b/i, provider: "chatgpt" },
  { pattern: /\bclaude\b/i, provider: "claude" },
  { pattern: /\b(?:gemini|bard)\b/i, provider: "gemini" },
  { pattern: /\bperplexity\b/i, provider: "perplexity" },
];

const FOCUS: { focus: QueryFocus; pattern: RegExp }[] = [
  { focus: "suggestions", pattern: /\b(?:suggest(?:ed|ion|ions)?|recommend(?:ed|ation|ations)?|advi[cs]e|propos(?:ed|al|als))\b/i },
  { focus: "decisions", pattern: /\b(?:decid(?:e|ed)|decision|decisions|chose|choose|settled|agree(?:d)? on)\b/i },
  { focus: "questions", pattern: /\b(?:unresolved|open questions?|still open|unanswered|not (?:yet )?(?:answered|solved|resolved)|remain(?:s|ing)? (?:open|unresolved))\b/i },
  { focus: "tasks", pattern: /\b(?:to-?dos?|tasks?|unfinished|follow[- ]?ups?|next steps?|need to do|left to do|pending)\b/i },
  { focus: "accomplished", pattern: /\b(?:accomplish(?:ed)?|achiev(?:ed|ements?)|finished|completed|progress|got done|what have i done)\b/i },
];

/** Words a question uses whatever it asks about. */
const FILLER = new Set(
  [
    "what", "which", "when", "where", "who", "did", "do", "does", "have", "has", "was", "were", "about", "with", "this", "that", "these", "those", "my", "i", "me",
    "conversation", "conversations", "chat", "chats", "discuss", "discussed", "discussing", "talk", "talked", "research", "researching", "researched", "previously",
    "earlier", "before", "find", "show", "ai", "investigate", "investigated", "later", "across", "all", "remain", "remaining", "still", "question", "questions",
    "decide", "decided", "decision", "decisions", "suggest", "suggested", "suggestion", "recommend", "accomplish", "accomplished", "task", "tasks", "week", "month",
    "day", "days", "today", "yesterday", "last", "past", "recent", "recently", "open", "unresolved", "project", "work", "working", "feature", "problem", "thing",
  ].flatMap((word) => textTerms(word).words.concat(word))
);

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY = 86_400_000;

function readTime(text: string, now: number): Pick<ParsedQuery, "since" | "until" | "timeLabel"> {
  const today = startOfDay(now);
  const weekday = (new Date(today).getDay() + 6) % 7; // Monday = 0
  const lastN = /\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/i.exec(text);
  if (lastN) {
    const unit = lastN[2]!.toLowerCase() === "day" ? DAY : lastN[2]!.toLowerCase() === "week" ? 7 * DAY : 30 * DAY;
    return { since: now - Number(lastN[1]) * unit, timeLabel: `in the last ${lastN[1]} ${lastN[2]}s` };
  }
  if (/\btoday\b/i.test(text)) return { since: today, timeLabel: "today" };
  if (/\byesterday\b/i.test(text)) return { since: today - DAY, until: today, timeLabel: "yesterday" };
  if (/\bthis week\b/i.test(text)) return { since: today - weekday * DAY, timeLabel: "this week" };
  if (/\blast week\b/i.test(text)) return { since: today - (weekday + 7) * DAY, until: today - weekday * DAY, timeLabel: "last week" };
  if (/\bpast week\b/i.test(text)) return { since: now - 7 * DAY, timeLabel: "in the past week" };
  if (/\bthis month\b/i.test(text)) {
    const date = new Date(today);
    date.setDate(1);
    return { since: date.getTime(), timeLabel: "this month" };
  }
  if (/\blast month\b/i.test(text)) {
    const start = new Date(today);
    start.setDate(1);
    start.setMonth(start.getMonth() - 1);
    const end = new Date(today);
    end.setDate(1);
    return { since: start.getTime(), until: end.getTime(), timeLabel: "last month" };
  }
  if (/\brecent(?:ly)?\b/i.test(text)) return { since: now - 14 * DAY, timeLabel: "recently" };
  return {};
}

export function parseQuery(text: string, now: number, projects: readonly { id: string; name: string }[] = [], context: { workspaceId?: string } = {}): ParsedQuery {
  const query = text.slice(0, 500);
  const providers: AiProviderId[] = [];
  let laterProvider: AiProviderId | undefined;
  const later = /\blater\b.*?\b(?:with|in|on|to)\s+([a-z][\w -]*)/i.exec(query);
  for (const { pattern, provider } of PROVIDER_WORDS) {
    if (!pattern.test(query)) continue;
    if (later && pattern.test(later[1]!) && !pattern.test(query.slice(0, later.index))) laterProvider = provider;
    else providers.push(provider);
  }
  const focus = FOCUS.find((entry) => entry.pattern.test(query))?.focus ?? "conversations";
  const folded = ` ${foldName(query)} `;
  const workspaceIds = projects.filter((project) => foldName(project.name).length >= 3 && folded.includes(` ${foldName(project.name)} `)).map((project) => project.id);
  if (workspaceIds.length === 0 && context.workspaceId && /\bthis (?:project|subject|feature)\b/i.test(query)) workspaceIds.push(context.workspaceId);
  const projectWords = new Set(projects.filter((project) => workspaceIds.includes(project.id)).flatMap((project) => textTerms(project.name).words));
  const providerWords = new Set(AI_PROVIDER_IDS.flatMap((id) => textTerms(`${id} ${aiProviderName(id)} gpt openai bard`).words));
  const subject = query.replace(/\b(?:last|past) \d{1,3} (?:day|week|month)s?\b/gi, " ");
  const terms = [...new Set(textTerms(subject).words)].filter((term) => !FILLER.has(term) && !providerWords.has(term) && !projectWords.has(term));
  const entities = lexiconIdsIn(subject).filter((id) => !AI_PROVIDER_IDS.includes(id as AiProviderId));
  return { text: query, terms, entities, providers, ...(laterProvider ? { laterProvider } : {}), ...readTime(query, now), workspaceIds, focus };
}

export type RankedConversation = {
  record: ConversationRecord;
  score: number;
  /** What matched, in words. */
  why: string[];
  /** The message that matched best, when one did. */
  evidence?: Evidence;
};

export type QueryAnswer = {
  query: ParsedQuery;
  conversations: RankedConversation[];
  facts: { fact: Fact; record: ConversationRecord; why?: string }[];
  threads: ConversationThread[];
  /** One sentence, counted from the results — never a claim the results don't hold. */
  summary: string;
  /** False when the saved conversations hold nothing that answers it. */
  enough: boolean;
};

function inRange(record: ConversationRecord, query: ParsedQuery): boolean {
  if (query.since === undefined && query.until === undefined) return true;
  const times = [record.updatedAt, record.createdAt, ...record.messages.map((message) => message.at).filter((at): at is number => at !== undefined)];
  return times.some((at) => (query.since === undefined || at >= query.since) && (query.until === undefined || at < query.until));
}

function bestMessage(record: ConversationRecord, terms: readonly string[]): Evidence | undefined {
  if (terms.length === 0) return undefined;
  const wanted = new Set(terms);
  let best: { index: number; score: number } | undefined;
  for (const message of record.messages) {
    const words = textTerms(message.text.slice(0, 20_000)).words;
    let score = 0;
    for (const word of new Set(words)) if (wanted.has(word)) score += message.role === "user" ? 1.2 : 1;
    if (score > 0 && (!best || score > best.score)) best = { index: message.index, score };
  }
  if (!best) return undefined;
  const message = record.messages[best.index]!;
  const lower = message.text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), lower.length) - 60);
  return { recordId: record.id, messageIndex: message.index, role: message.role, quote: `${at > 0 ? "…" : ""}${message.text.slice(at, at + 220).replace(/\s+/g, " ").trim()}` };
}

const FOLLOW_UP_LIMIT = 30;

// What every query over one index needs, worked out once per index: it is rebuilt only when the corpus changes.
type Prepared = { analyzed: ConversationRecord[]; df: Map<string, number>; recordById: Map<string, ConversationRecord>; threadsOf: Map<string, ConversationThread[]> };
const prepared = new WeakMap<ConversationIndex, Prepared>();
const titleWords = new WeakMap<ConversationRecord, Set<string>>();

function prepare(index: ConversationIndex): Prepared {
  let entry = prepared.get(index);
  if (entry) return entry;
  const analyzed = index.records.filter((record) => index.processing.get(record.id) === "analyzed");
  const df = new Map<string, number>();
  for (const record of analyzed) for (const term of Object.keys(index.extractions.get(record.id)?.terms ?? {})) df.set(term, (df.get(term) ?? 0) + 1);
  const threadsOf = new Map<string, ConversationThread[]>();
  for (const thread of index.threads) for (const id of thread.recordIds) threadsOf.set(id, [...(threadsOf.get(id) ?? []), thread]);
  entry = { analyzed, df, recordById: new Map(index.records.map((record) => [record.id, record])), threadsOf };
  prepared.set(index, entry);
  return entry;
}

function titleWordsOf(record: ConversationRecord): Set<string> {
  let words = titleWords.get(record);
  if (!words) titleWords.set(record, (words = new Set(textTerms(record.title).words)));
  return words;
}

export function answerQuery(index: ConversationIndex, query: ParsedQuery, options: { limit?: number } = {}): QueryAnswer {
  const limit = options.limit ?? 12;
  const { analyzed, df, recordById, threadsOf } = prepare(index);
  const total = analyzed.length;
  const passes = (record: ConversationRecord) =>
    (query.providers.length === 0 || (record.provider !== undefined && query.providers.includes(record.provider))) &&
    (query.workspaceIds.length === 0 || query.workspaceIds.includes(record.workspaceId)) &&
    inRange(record, query);

  const scored = new Map<string, RankedConversation>();
  const subject = query.terms.length > 0 || query.entities.length > 0;
  for (const record of analyzed) {
    if (!passes(record) && !(query.laterProvider && record.provider === query.laterProvider)) continue;
    const extraction = index.extractions.get(record.id)!;
    let score = 0;
    const why: string[] = [];
    if (subject) {
      const titleWords = titleWordsOf(record);
      const topicTerms = new Set((index.topics.get(record.id) ?? []).map((topic) => topic.term));
      const matched: string[] = [];
      for (const term of query.terms) {
        const tf = extraction.terms[term];
        if (tf === undefined && !titleWords.has(term)) continue;
        matched.push(extraction.spelling[term] ?? term);
        score += (titleWords.has(term) ? 3 : 0) + (tf ? Math.log(1 + tf) * Math.log(1 + total / (df.get(term) ?? 1)) : 0) + (topicTerms.has(term) ? 1 : 0);
      }
      const named = extraction.entities.filter((entity) => query.entities.includes(entity.id));
      score += named.length * 2.5;
      if (matched.length > 0) why.push(`mentions ${matched.slice(0, 4).join(", ")}`);
      if (named.length > 0) why.push(`names ${named.map((entity) => entity.name).join(", ")}`);
      // Every word of the subject found counts for more than one word found many times.
      if (query.terms.length > 1) score *= 0.5 + (0.5 * matched.length) / query.terms.length;
      if (score <= 0) continue;
    } else {
      score = 1;
    }
    scored.set(record.id, { record, score: Math.round(score * 100) / 100, why });
  }

  // Conversations in the same thread as a strong match are about the same objective.
  const threadsHit: ConversationThread[] = [];
  if (subject) {
    const top = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const hit of top) {
      for (const thread of threadsOf.get(hit.record.id) ?? []) {
        if (!threadsHit.includes(thread)) threadsHit.push(thread);
        for (const id of thread.recordIds) {
          if (scored.has(id)) continue;
          const record = recordById.get(id);
          if (!record || !passes(record)) continue;
          scored.set(id, { record, score: Math.round(hit.score * 0.4 * 100) / 100, why: [`same thread as “${hit.record.title}”`] });
        }
      }
    }
  }

  const ranked = [...scored.values()].filter((entry) => !query.laterProvider || passes(entry.record) || entry.record.provider === query.laterProvider);
  ranked.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt || (a.record.id < b.record.id ? -1 : 1));

  // A later conversation in the other app, found by the words it shares with a suggestion.
  let followers: Map<string, ConversationRecord[]> | undefined;
  const followUpOf = (fact: Fact, record: ConversationRecord) => {
    if (!followers) {
      followers = new Map();
      for (const other of analyzed) {
        if (other.provider !== query.laterProvider) continue;
        for (const term of Object.keys(index.extractions.get(other.id)?.terms ?? {})) followers.set(term, [...(followers.get(term) ?? []), other]);
      }
    }
    const overlap = new Map<ConversationRecord, number>();
    for (const term of new Set(fact.terms)) for (const other of followers.get(term) ?? []) overlap.set(other, (overlap.get(other) ?? 0) + 1);
    let found: ConversationRecord | undefined;
    for (const other of analyzed) {
      if ((overlap.get(other) ?? 0) < 2 || other.id === record.id || other.createdAt < (fact.at ?? record.createdAt)) continue;
      found = other;
      break;
    }
    return found;
  };

  // The answer's facts.
  const factsOut: QueryAnswer["facts"] = [];
  if (query.focus !== "conversations") {
    const inScope = new Set(ranked.filter((entry) => passes(entry.record)).map((entry) => entry.record.id));
    const wanted = (fact: Fact) => {
      switch (query.focus) {
        case "decisions":
          return fact.kind === "decision" && fact.status !== "suggested";
        case "questions":
          return fact.kind === "question";
        case "tasks":
          return fact.kind === "task" && fact.status !== "done";
        case "accomplished":
          return (fact.kind === "task" && fact.status === "done") || (fact.kind === "decision" && (fact.status === "decided" || fact.status === "accepted")) || (fact.kind === "knowledge" && fact.status === "confirmed");
        case "suggestions":
          return fact.attribution === "assistant" && (fact.kind === "decision" || fact.kind === "task");
        default:
          return false;
      }
    };
    const candidates: Fact[] = [];
    for (const fact of index.facts) {
      if (!inScope.has(fact.recordId) || !wanted(fact)) continue;
      if (subject && query.terms.length > 0 && !fact.terms.some((term) => query.terms.includes(term)) && !fact.entities.some((id) => query.entities.includes(id)) && (scored.get(fact.recordId)?.score ?? 0) < 2) continue;
      candidates.push(fact);
    }
    if (query.laterProvider) {
      // A suggestion counts only if a later conversation in the other app took up its subject.
      // Newest first, and only as many as an answer shows: following every suggestion up is the costly part.
      const timeOf = (fact: Fact) => fact.at ?? recordById.get(fact.recordId)!.updatedAt;
      candidates.sort((x, y) => timeOf(y) - timeOf(x));
      let checked = 0;
      for (const fact of candidates) {
        if (factsOut.length >= FOLLOW_UP_LIMIT || checked++ >= FOLLOW_UP_LIMIT * 20) break;
        const record = recordById.get(fact.recordId)!;
        const followUp = followUpOf(fact, record);
        if (!followUp || followUp.updatedAt < timeOf(fact) - DAY) continue;
        factsOut.push({ fact, record, why: `later discussed in “${followUp.title}” (${aiProviderName(followUp.provider)})` });
      }
    } else for (const fact of candidates) factsOut.push({ fact, record: recordById.get(fact.recordId)! });
    factsOut.sort((a, b) => (b.fact.at ?? b.record.updatedAt) - (a.fact.at ?? a.record.updatedAt) || b.fact.confidence - a.fact.confidence);
  }

  // The matching message, for what is shown only.
  const conversations = ranked
    .filter((entry) => passes(entry.record))
    .slice(0, limit)
    .map((entry) => (subject && !entry.evidence && entry.why[0]?.startsWith("same thread") !== true ? { ...entry, evidence: bestMessage(entry.record, query.terms) } : entry));
  const enough = query.focus === "conversations" ? conversations.length > 0 && (!subject || conversations[0]!.score >= 1) : factsOut.length > 0;
  return { query, conversations, facts: factsOut.slice(0, 30), threads: threadsHit, summary: summarize(query, conversations, factsOut, enough, index), enough };
}

const FOCUS_NOUN: Record<QueryFocus, [string, string]> = {
  conversations: ["conversation", "conversations"],
  decisions: ["decision", "decisions"],
  questions: ["open question", "open questions"],
  tasks: ["open task", "open tasks"],
  accomplished: ["thing done or decided", "things done or decided"],
  suggestions: ["AI suggestion", "AI suggestions"],
};

function summarize(query: ParsedQuery, conversations: readonly RankedConversation[], facts: QueryAnswer["facts"], enough: boolean, index: ConversationIndex): string {
  const when = query.timeLabel ? ` ${query.timeLabel}` : "";
  const apps = query.providers.length > 0 ? ` in ${query.providers.map(aiProviderName).join(" or ")}` : "";
  if (!enough) {
    const analyzed = [...index.processing.values()].filter((state) => state === "analyzed").length;
    return analyzed === 0
      ? "No saved conversations have been analysed yet, so there is nothing to answer from."
      : `Nothing in your ${analyzed} analysed conversation${analyzed === 1 ? "" : "s"}${apps}${when} answers this. Hubble only knows conversations you saved.`;
  }
  const [one, many] = FOCUS_NOUN[query.focus];
  if (query.focus === "conversations") {
    const words = new Map<string, number>();
    for (const entry of conversations) for (const topic of (index.topics.get(entry.record.id) ?? []).slice(0, 3)) words.set(topic.label, (words.get(topic.label) ?? 0) + 1);
    const top = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([word]) => word);
    return `${conversations.length} ${conversations.length === 1 ? one : many}${apps}${when}${top.length > 0 ? ` — mostly about ${top.join(", ")}` : ""}.`;
  }
  const records = new Set(facts.map((entry) => entry.record.id));
  const providers = [...new Set(facts.map((entry) => entry.record.provider).filter((provider): provider is AiProviderId => !!provider))].map(aiProviderName);
  return `${facts.length} ${facts.length === 1 ? one : many} in ${records.size} conversation${records.size === 1 ? "" : "s"}${providers.length > 0 ? ` (${providers.join(", ")})` : ""}${when}.`;
}

/**
 * Conversations to look at before starting something: the ones whose topics
 * the new task's words (or a project's) name, best first. Used when a
 * conversation or project is opened, never pushed as a notification.
 */
export function relevantConversations(index: ConversationIndex, text: string, now: number, exclude: ReadonlySet<string> = new Set(), limit = 5): RankedConversation[] {
  const query = parseQuery(text, now);
  if (query.terms.length === 0 && query.entities.length === 0) return [];
  return answerQuery(index, { ...query, focus: "conversations", providers: [], workspaceIds: [] }, { limit: limit + exclude.size })
    .conversations.filter((entry) => !exclude.has(entry.record.id) && entry.score >= 1.5)
    .slice(0, limit);
}

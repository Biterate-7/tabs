import { scopedKey } from "@/lib/storage/namespace";
import { isAiProviderId } from "@/lib/providers/registry";
import type { AiProviderId } from "@/lib/providers/registry";
import type { FactStatus, RelationLevel } from "./types";

/**
 * What the person decided about conversation intelligence — the only part of
 * it that is stored. Everything Hubble *derived* (topics, decisions, threads,
 * memories) is recomputed from the saved text; this holds the person's
 * choices about it:
 *
 *   enabled        analyse saved conversations at all (on this device)
 *   providers      analyse conversations from this AI app — off leaves them
 *                  saved and searchable, just not analysed
 *   excluded       single conversations left out of analysis, by identity
 *   facts          corrections: "that's right" / "that's wrong", or "that was
 *                  only the AI's suggestion" — always winning over extraction
 *   unrelated      pairs of conversations the person said are not related
 *   related        pairs the person said are related
 *   reviews        the person's verdicts from reviewing Hubble's links
 *                  (Settings → Conversations → Check Hubble's links): what
 *                  the precision figures are computed from, on this device
 *   dismissed      insights the person closed
 *   semantic       compare conversations by meaning with an on-device model
 *                  (off until the person turns it on: it downloads the model)
 *
 * Partitioned by account (SCOPED_STORAGE_KEYS). Turning analysis off never
 * deletes a saved conversation — deleting one is done on the conversation
 * itself, and everything derived from it, and every correction about it,
 * goes with it (`pruneSettings`).
 */

export const CONVERSATION_INTELLIGENCE_KEY = "tabdump:conversation-intelligence:v1";

export type FactCorrection = {
  /** "confirmed": the person says it is right. "rejected": it is wrong — never shown or used again. */
  verdict?: "confirmed" | "rejected";
  /** A status the person set (e.g. a "decided" that was really only "suggested", a task now "done"). */
  status?: FactStatus;
  at: number;
};

/** One reviewed link (or near miss), and what Hubble had shown for it at the time. */
export type PairReview = {
  verdict: "related" | "unrelated";
  /** How they relate, when the person said. */
  level?: RelationLevel;
  /** What Hubble had proposed: the level it showed, or "none" for a near miss it did not show. */
  proposed: RelationLevel | "none";
  /** Which evidence had proposed it. */
  methods: ("words" | "meaning")[];
  lexical: number;
  semantic?: number;
  at: number;
};

export type IntelligenceSettings = {
  version: 1;
  enabled: boolean;
  providers: Partial<Record<AiProviderId, boolean>>;
  excluded: string[];
  facts: Record<string, FactCorrection>;
  unrelated: string[];
  related: string[];
  reviews: Record<string, PairReview>;
  dismissed: string[];
  semantic: boolean;
};

export const DEFAULT_INTELLIGENCE_SETTINGS: IntelligenceSettings = Object.freeze({
  version: 1,
  enabled: true,
  providers: {},
  excluded: [],
  facts: {},
  unrelated: [],
  related: [],
  reviews: {},
  dismissed: [],
  semantic: false,
}) as IntelligenceSettings;

const LIMITS = { ids: 5_000, idLength: 400 } as const;
const LEVELS = new Set<string>(["same-problem", "same-project", "related-topic", "shared-entity"]);
const STATUSES = new Set<string>(["decided", "accepted", "suggested", "considered", "rejected", "committed", "done", "confirmed", "unconfirmed", "unresolved"]);

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= LIMITS.idLength))].slice(0, LIMITS.ids) : [];

/** Stored settings, re-read strictly: anything malformed is dropped, never trusted. */
export function readIntelligenceSettings(raw: unknown): IntelligenceSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_INTELLIGENCE_SETTINGS;
  const value = raw as Record<string, unknown>;
  const providers: Partial<Record<AiProviderId, boolean>> = {};
  if (value.providers && typeof value.providers === "object") {
    for (const [id, on] of Object.entries(value.providers as Record<string, unknown>)) if (isAiProviderId(id) && typeof on === "boolean") providers[id] = on;
  }
  const facts: Record<string, FactCorrection> = {};
  if (value.facts && typeof value.facts === "object") {
    for (const [id, entry] of Object.entries(value.facts as Record<string, unknown>).slice(0, LIMITS.ids)) {
      if (id.length > LIMITS.idLength || !entry || typeof entry !== "object") continue;
      const correction = entry as Record<string, unknown>;
      const verdict = correction.verdict === "confirmed" || correction.verdict === "rejected" ? correction.verdict : undefined;
      const status = typeof correction.status === "string" && STATUSES.has(correction.status) ? (correction.status as FactStatus) : undefined;
      if (!verdict && !status) continue;
      facts[id] = { ...(verdict ? { verdict } : {}), ...(status ? { status } : {}), at: typeof correction.at === "number" && Number.isFinite(correction.at) ? correction.at : 0 };
    }
  }
  const reviews: Record<string, PairReview> = {};
  if (value.reviews && typeof value.reviews === "object") {
    for (const [pair, entry] of Object.entries(value.reviews as Record<string, unknown>).slice(0, LIMITS.ids)) {
      if (pair.length > LIMITS.idLength * 2 || !pair.includes("|") || !entry || typeof entry !== "object") continue;
      const review = entry as Record<string, unknown>;
      if (review.verdict !== "related" && review.verdict !== "unrelated") continue;
      const proposed = review.proposed === "none" || (typeof review.proposed === "string" && LEVELS.has(review.proposed)) ? (review.proposed as PairReview["proposed"]) : undefined;
      const lexical = typeof review.lexical === "number" && Number.isFinite(review.lexical) ? review.lexical : undefined;
      if (!proposed || lexical === undefined) continue;
      const methods = Array.isArray(review.methods) ? review.methods.filter((method): method is "words" | "meaning" => method === "words" || method === "meaning") : [];
      reviews[pair] = {
        verdict: review.verdict,
        ...(typeof review.level === "string" && LEVELS.has(review.level) ? { level: review.level as RelationLevel } : {}),
        proposed,
        methods: [...new Set(methods)],
        lexical,
        ...(typeof review.semantic === "number" && Number.isFinite(review.semantic) ? { semantic: review.semantic } : {}),
        at: typeof review.at === "number" && Number.isFinite(review.at) ? review.at : 0,
      };
    }
  }
  return {
    version: 1,
    enabled: value.enabled !== false,
    providers,
    excluded: idList(value.excluded),
    facts,
    unrelated: idList(value.unrelated),
    related: idList(value.related),
    reviews,
    dismissed: idList(value.dismissed),
    semantic: value.semantic === true,
  };
}

export function loadIntelligenceSettings(): IntelligenceSettings {
  try {
    const raw = window.localStorage.getItem(scopedKey(CONVERSATION_INTELLIGENCE_KEY));
    return raw ? readIntelligenceSettings(JSON.parse(raw)) : DEFAULT_INTELLIGENCE_SETTINGS;
  } catch {
    return DEFAULT_INTELLIGENCE_SETTINGS;
  }
}

/** Writes the settings; says whether it could. */
export function saveIntelligenceSettings(settings: IntelligenceSettings): boolean {
  try {
    window.localStorage.setItem(scopedKey(CONVERSATION_INTELLIGENCE_KEY), JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** A pair of conversations, the same whichever way round. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function isProviderAnalyzed(settings: IntelligenceSettings, provider: AiProviderId | undefined): boolean {
  return !provider || settings.providers[provider] !== false;
}

export function correctFact(settings: IntelligenceSettings, factId: string, correction: Omit<FactCorrection, "at">, now: number): IntelligenceSettings {
  const facts = { ...settings.facts };
  if (!correction.verdict && !correction.status) delete facts[factId];
  else facts[factId] = { ...correction, at: now };
  return { ...settings, facts };
}

export function setExcluded(settings: IntelligenceSettings, identity: string, excluded: boolean): IntelligenceSettings {
  const rest = settings.excluded.filter((id) => id !== identity);
  return { ...settings, excluded: excluded ? [...rest, identity] : rest };
}

export function setProviderAnalyzed(settings: IntelligenceSettings, provider: AiProviderId, on: boolean): IntelligenceSettings {
  return { ...settings, providers: { ...settings.providers, [provider]: on } };
}

export function markUnrelated(settings: IntelligenceSettings, a: string, b: string): IntelligenceSettings {
  const key = pairKey(a, b);
  const related = settings.related.filter((pair) => pair !== key);
  if (settings.unrelated.includes(key) && related.length === settings.related.length) return settings;
  return { ...settings, unrelated: settings.unrelated.includes(key) ? settings.unrelated : [...settings.unrelated, key], related };
}

export function markRelated(settings: IntelligenceSettings, a: string, b: string): IntelligenceSettings {
  const key = pairKey(a, b);
  const unrelated = settings.unrelated.filter((pair) => pair !== key);
  if (settings.related.includes(key) && unrelated.length === settings.unrelated.length) return settings;
  return { ...settings, related: settings.related.includes(key) ? settings.related : [...settings.related, key], unrelated };
}

/**
 * The person's verdict on a link Hubble showed (or a near miss it didn't):
 * recorded for the precision figures, and applied. "Not related" keeps the
 * pair apart from now on, "related" keeps it together. Nothing else changes:
 * no conversation moves between projects.
 */
export function reviewPair(settings: IntelligenceSettings, a: string, b: string, review: Omit<PairReview, "at">, now: number): IntelligenceSettings {
  const applied = review.verdict === "related" ? markRelated(settings, a, b) : markUnrelated(settings, a, b);
  return { ...applied, reviews: { ...applied.reviews, [pairKey(a, b)]: { ...review, at: now } } };
}

/** Forgets every review (the corrections they made stay). */
export function clearReviews(settings: IntelligenceSettings): IntelligenceSettings {
  return Object.keys(settings.reviews).length === 0 ? settings : { ...settings, reviews: {} };
}

export function dismissInsight(settings: IntelligenceSettings, insightId: string): IntelligenceSettings {
  return settings.dismissed.includes(insightId) ? settings : { ...settings, dismissed: [...settings.dismissed, insightId] };
}

/**
 * The settings with everything about conversations that no longer exist
 * removed: corrections (fact ids begin with their record id), exclusions,
 * "not related" pairs and dismissed insights that name a record. Called with
 * the records the store holds now — so deleting a conversation also deletes
 * what the person said about it. Returns the same object when nothing went.
 */
export function pruneSettings(settings: IntelligenceSettings, live: { recordIds: ReadonlySet<string>; identities: ReadonlySet<string> }): IntelligenceSettings {
  const recordOf = (factId: string) => {
    // `<workspace>:<s|n>:<item>:<kind>:<hash>` — the record id is the first three parts.
    const parts = factId.split(":");
    return parts.slice(0, 3).join(":");
  };
  const facts = Object.fromEntries(Object.entries(settings.facts).filter(([id]) => live.recordIds.has(recordOf(id))));
  const excluded = settings.excluded.filter((identity) => live.identities.has(identity));
  const livePair = (pair: string) => pair.split("|").every((id) => live.recordIds.has(id));
  const unrelated = settings.unrelated.filter(livePair);
  const related = settings.related.filter(livePair);
  const reviews = Object.fromEntries(Object.entries(settings.reviews).filter(([pair]) => livePair(pair)));
  const dismissed = settings.dismissed.filter((id) => !id.includes("@") || id.split("@")[1]!.split(",").every((recordId) => live.recordIds.has(recordId)));
  const same =
    Object.keys(facts).length === Object.keys(settings.facts).length &&
    excluded.length === settings.excluded.length &&
    unrelated.length === settings.unrelated.length &&
    related.length === settings.related.length &&
    Object.keys(reviews).length === Object.keys(settings.reviews).length &&
    dismissed.length === settings.dismissed.length;
  return same ? settings : { ...settings, facts, excluded, unrelated, related, reviews, dismissed };
}

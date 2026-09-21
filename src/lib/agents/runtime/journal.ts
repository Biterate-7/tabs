import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { SequencedControlEvent } from "./protocol";

/**
 * The event journal: ordering and idempotency for the live wire.
 *
 * ## Why a timestamp is not an order
 *
 * Provider events arrive asynchronously. Two of them can carry the same
 * millisecond; a clock can step backwards over an NTP correction; an adapter
 * can normalize one provider message into three events that all read `now()`
 * once. Sorting a transcript by timestamp therefore produces *a* sequence,
 * just not reliably the one that happened - and a UI that rendered a tool
 * result above the tool call that produced it would be showing the user
 * something false.
 *
 * So the host stamps a monotonic `sequence` on every event as it accepts it,
 * per session, starting at 1. It is not a guess about provider ordering: it
 * is the exact order in which this runtime received them, which is the only
 * ordering this runtime can honestly assert. If a provider ever supplies its
 * own sequence, that belongs beside this one rather than instead of it -
 * `sourceId` is already where the provider's own identity lives.
 *
 * ## Idempotency
 *
 * A reconnecting client re-reads from a cursor; an adapter re-attaching to a
 * provider stream can replay. Neither may produce a second approval, a second
 * tool execution or a second completion downstream.
 *
 * The journal deduplicates on the strongest identity available:
 *
 *   1. `provider + sourceId` when the provider gave one. That is a
 *      provider-stable id for the source record, so a replay of the same
 *      record is recognisable even across a restart of the adapter.
 *   2. `event.id` otherwise. Minted by the adapter and unique within its
 *      lifetime, which covers the replay-within-a-process case.
 *
 * A duplicate is *dropped*, not renumbered: it never reaches a listener, so
 * a subscriber cannot act on it twice.
 *
 * ## Why it is bounded
 *
 * A chatty session emits events faster than a person reads them, and this
 * journal exists so a browser that was away for thirty seconds can catch up -
 * not so that a week of activity can be replayed. That is the domain's
 * durable log's job, and it already has its own cap. When the ring fills, the
 * oldest events go and `droppedBefore` records where the gap is, so a client
 * asking for a cursor that has fallen off the back is told so rather than
 * silently handed an incomplete history.
 */

/** Events kept per session. Roughly a few minutes of a busy run. */
export const MAX_JOURNAL_EVENTS_PER_SESSION = 500;

/** Sessions kept. Bounds a long-lived host that has started many sessions. */
export const MAX_JOURNAL_SESSIONS = 100;

export type JournalAppendResult =
  | { accepted: true; event: SequencedControlEvent }
  | { accepted: false; reason: "duplicate" };

export type JournalRead = {
  events: readonly SequencedControlEvent[];
  latestSequence: number;
  /**
   * The lowest sequence still held.
   *
   * A client whose cursor is below this has missed events. Saying so is the
   * whole reason the field exists: the alternative is handing back a
   * truncated history that looks complete.
   */
  oldestSequence: number;
  /** Whether events before `oldestSequence` were dropped to stay within the cap. */
  truncated: boolean;
};

export type EventJournal = {
  /** Stamps and stores an event, or reports it as a duplicate. */
  append(event: AgentControlEvent): JournalAppendResult;

  /** Everything after a cursor. An absent cursor means everything held. */
  read(sessionId: string, afterSequence?: number): JournalRead;

  latestSequence(sessionId: string): number;

  /** Forgets one session's events. Called when a session is disposed. */
  forget(sessionId: string): void;

  clear(): void;
};

type SessionJournal = {
  events: SequencedControlEvent[];
  sequence: number;
  /** Identities already seen, in insertion order, so the set can be trimmed with the ring. */
  seen: Set<string>;
  truncated: boolean;
  touchedAt: number;
};

/** The strongest identity available for this event. See the note above. */
function identityOf(event: AgentControlEvent): string {
  return event.sourceId
    ? `src:${event.provider}:${event.sourceId}`
    : `evt:${event.id}`;
}

export function createEventJournal(
  options: { maxEventsPerSession?: number; maxSessions?: number } = {}
): EventJournal {
  const maxEvents = options.maxEventsPerSession ?? MAX_JOURNAL_EVENTS_PER_SESSION;
  const maxSessions = options.maxSessions ?? MAX_JOURNAL_SESSIONS;

  const journals = new Map<string, SessionJournal>();
  let clock = 0;

  function journalFor(sessionId: string): SessionJournal {
    const existing = journals.get(sessionId);
    if (existing) {
      existing.touchedAt = ++clock;
      return existing;
    }

    const created: SessionJournal = {
      events: [],
      sequence: 0,
      seen: new Set(),
      truncated: false,
      touchedAt: ++clock,
    };
    journals.set(sessionId, created);

    if (journals.size > maxSessions) {
      // Least recently touched, not oldest-created: a session that is still
      // producing events is the one worth keeping.
      let oldestId: string | undefined;
      let oldestTouch = Infinity;
      for (const [id, journal] of journals) {
        if (journal.touchedAt < oldestTouch) {
          oldestTouch = journal.touchedAt;
          oldestId = id;
        }
      }
      if (oldestId !== undefined && oldestId !== sessionId) journals.delete(oldestId);
    }

    return created;
  }

  return {
    append(event) {
      const journal = journalFor(event.sessionId);
      const identity = identityOf(event);

      if (journal.seen.has(identity)) return { accepted: false, reason: "duplicate" };
      journal.seen.add(identity);

      const sequenced: SequencedControlEvent = { ...event, sequence: ++journal.sequence };
      journal.events.push(sequenced);

      if (journal.events.length > maxEvents) {
        const dropped = journal.events.splice(0, journal.events.length - maxEvents);
        journal.truncated = true;
        // The identity set is trimmed with the ring, so it cannot grow
        // without bound either. A replay of something dropped this long ago
        // would be renumbered rather than deduplicated, which is the right
        // trade: the alternative is an identity set that outlives its events
        // and leaks.
        for (const gone of dropped) journal.seen.delete(identityOf(gone));
      }

      return { accepted: true, event: sequenced };
    },

    read(sessionId, afterSequence) {
      const journal = journals.get(sessionId);
      if (!journal) {
        return { events: [], latestSequence: 0, oldestSequence: 0, truncated: false };
      }

      const events =
        afterSequence === undefined
          ? [...journal.events]
          : journal.events.filter((event) => event.sequence > afterSequence);

      return {
        events,
        latestSequence: journal.sequence,
        oldestSequence: journal.events[0]?.sequence ?? journal.sequence,
        truncated: journal.truncated,
      };
    },

    latestSequence: (sessionId) => journals.get(sessionId)?.sequence ?? 0,

    forget: (sessionId) => {
      journals.delete(sessionId);
    },

    clear: () => journals.clear(),
  };
}

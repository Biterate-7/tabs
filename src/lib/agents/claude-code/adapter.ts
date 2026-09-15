import { CLAUDE_CODE_PROVIDER, CLAUDE_POLL_INTERVAL_MS } from "./types";
import type { ClaudeObservationResponse } from "./contract";
import type { ClaudeDiscoveredSession } from "./types";
import type { AgentAdapter, AgentAdapterObservation, AgentObserver } from "@/lib/agents/adapter";

/**
 * The Claude Code implementation of Phase 11's `AgentAdapter`.
 *
 * It satisfies exactly that interface — `provider` and `subscribe` — and
 * therefore has no way to act on a session. It polls the local endpoint,
 * hands the resulting observations to its subscribers, and stops when the
 * last one leaves. That is the whole surface.
 *
 * Polling rather than a socket: the only push channel Claude Code exposes is
 * `messagingSocketPath`, which is a *control* channel and deliberately
 * untouched. A timer against a bounded endpoint is the honest way to watch a
 * local file, and a WebSocket would add infrastructure without adding a
 * signal that exists to carry.
 */

export type ClaudeCodeAdapter = AgentAdapter & {
  /** Sessions seen on the most recent poll, for mapping UI. */
  getSessions(): ClaudeDiscoveredSession[];
  /** Whether the last poll found a local Claude Code installation. */
  isAvailable(): boolean;
  /** Forces a poll now, resolving once it has been delivered. For tests and explicit refresh. */
  refresh(): Promise<void>;
};

export type ClaudeCodeAdapterOptions = {
  /** Injected so tests need no network and no fake timers. */
  fetchObservations?: (cursor: string) => Promise<ClaudeObservationResponse>;
  /**
   * Called after every poll with the non-observation results.
   *
   * Session listings and availability are polled state but are not
   * observations, and pushing them here is what lets a consumer avoid running
   * a second timer of its own just to read them back.
   */
  onPoll?: (state: { sessions: ClaudeDiscoveredSession[]; available: boolean }) => void;
  intervalMs?: number;
  /** Injected for tests; defaults to the platform scheduler. */
  scheduler?: {
    setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  };
};

async function defaultFetch(cursor: string): Promise<ClaudeObservationResponse> {
  const response = await fetch("/api/agents/claude-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor }),
  });

  if (!response.ok) throw new Error(`claude-code observation failed: ${response.status}`);
  return (await response.json()) as ClaudeObservationResponse;
}

export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {}
): ClaudeCodeAdapter {
  const fetchObservations = options.fetchObservations ?? defaultFetch;
  const intervalMs = options.intervalMs ?? CLAUDE_POLL_INTERVAL_MS;
  const scheduler = options.scheduler ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle),
  };

  const observers = new Set<AgentObserver>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let cursor = "";
  let sessions: ClaudeDiscoveredSession[] = [];
  let available = false;

  /**
   * Guards against overlapping polls.
   *
   * A slow read (a large backlog, a busy disk) must not stack requests behind
   * it: the next tick is skipped rather than queued, so the endpoint is never
   * asked to do two sweeps at once and the cursor can never be advanced by
   * two responses racing each other.
   */
  let inFlight = false;

  async function poll(): Promise<void> {
    if (inFlight) return;
    inFlight = true;

    try {
      const response = await fetchObservations(cursor);
      available = response.available;
      sessions = response.sessions ?? [];

      // Only advance on a well-formed response. Keeping the old cursor after a
      // failure means the next poll re-reads the same bytes, which is safe —
      // events carry stable source ids and dedupe downstream.
      if (response.cursor) cursor = response.cursor;

      const observations = response.observations ?? [];
      if (observations.length > 0) emit(observations);
    } catch {
      // A failed poll is not a terminal event. It says nothing about the
      // sessions themselves, so nothing about them is changed — in
      // particular, no run is marked failed because a read did not land.
      available = false;
    } finally {
      inFlight = false;
      options.onPoll?.({ sessions, available });
    }
  }

  function emit(observations: AgentAdapterObservation[]): void {
    // Snapshot: an observer that unsubscribes while being notified would
    // otherwise mutate the set mid-iteration.
    for (const observer of [...observers]) observer(observations);
  }

  function start(): void {
    if (timer !== null) return;
    timer = scheduler.setInterval(() => void poll(), intervalMs);
    void poll();
  }

  function stop(): void {
    if (timer === null) return;
    scheduler.clearInterval(timer);
    timer = null;
  }

  return {
    provider: CLAUDE_CODE_PROVIDER,

    subscribe(observer: AgentObserver) {
      observers.add(observer);
      // The loop exists only while someone is listening: one timer for any
      // number of subscribers, and none at all for zero.
      start();

      return () => {
        observers.delete(observer);
        if (observers.size === 0) stop();
      };
    },

    getSessions: () => sessions,
    isAvailable: () => available,
    refresh: poll,
  };
}

import type { AgentAdapter, AgentAdapterObservation, AgentObserver } from "./adapter";

/**
 * An in-memory AgentAdapter for tests.
 *
 * Exists so the seam in ./adapter.ts can be exercised without any provider,
 * filesystem or network: a test pushes observations and asserts what the
 * domain did with them. It observes nothing real and must never grow the
 * ability to — if a mock needed a `start()` to be useful, that would be a
 * signal the interface had drifted, not that the mock needed the method.
 */
export type MockAgentAdapter = AgentAdapter & {
  /** Delivers observations to every live subscriber. */
  emit(observations: AgentAdapterObservation[]): void;
  /** How many subscribers are currently attached — lets a test prove unsubscribe actually detaches. */
  readonly subscriberCount: number;
};

export function createMockAgentAdapter(provider = "mock"): MockAgentAdapter {
  const observers = new Set<AgentObserver>();

  return {
    provider,

    subscribe(observer: AgentObserver) {
      observers.add(observer);
      // Idempotent: calling the returned function twice detaches once and
      // then does nothing, which is the contract a React effect cleanup
      // needs under StrictMode's deliberate double-invocation.
      return () => {
        observers.delete(observer);
      };
    },

    emit(observations: AgentAdapterObservation[]) {
      // Snapshot first: an observer that unsubscribes while being notified
      // would otherwise mutate the set mid-iteration.
      for (const observer of [...observers]) observer(observations);
    },

    get subscriberCount() {
      return observers.size;
    },
  };
}

import type { AgentControlAdapter } from "./types";

/**
 * How an adapter says "my last `connect()` has finished" (Agent
 * Authentication & Runtime).
 *
 * ## Why this exists
 *
 * `connect()` sets the adapter's status to `connecting` and only then asks
 * whether it can run — a module load, a credential lookup, a probe process.
 * A host that reads the status in between reports `connecting`, which is
 * true for a moment and a lie if nothing ever reads it again.
 *
 * That is exactly what a hosted deployment did: its runtime host is built per
 * request, so every `get_status` was answered by a brand-new adapter whose
 * `connect()` had not settled yet — and the Command Centre showed "Connecting"
 * forever to a user who was signed out or had nothing configured. The host now
 * waits, for a bounded moment, on any adapter that can say when it settles, so
 * the answer it gives is the adapter's real one.
 *
 * ## Why an extension, like `session-release.ts`
 *
 * The base contract reads the same for every provider. An adapter whose
 * `connect()` is synchronous in effect has nothing to wait for and does not
 * implement this; the host checks structurally, never by provider.
 */
export type SettlingAdapter = AgentControlAdapter & {
  /**
   * Resolves once no `connect()` is in flight. Never rejects, and resolves at
   * once when nothing is pending. Callers bound how long they wait.
   */
  connectSettled(): Promise<void>;
};

export function hasConnectSettle(adapter: AgentControlAdapter): adapter is SettlingAdapter {
  return typeof (adapter as Partial<SettlingAdapter>).connectSettled === "function";
}

/**
 * Resolves with the promise's value, or with `onTimeout` once `ms` passes.
 *
 * The timer is cleared either way, so a settled race leaves nothing that
 * keeps a process awake.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

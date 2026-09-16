import { isLiveConnectorStatus } from "./types";
import type { ConnectorHealth, ConnectorStatus } from "./types";

/**
 * Health, derived from what a connector has actually done.
 *
 * Every input here is a real, recorded fact — the status it is in, when it
 * last delivered something, whether its last attempt failed. Nothing is
 * simulated, no timer ticks a "heartbeat" that would show life where there is
 * none, and a connector that has never observed anything says so rather than
 * reporting green.
 *
 * Pure, with the clock injected, for the same reason every reducer in the
 * agent domain is (see src/lib/reducer-purity.test.ts): a health badge that
 * read `Date.now()` during render would be a different value on every pass.
 */

/**
 * How long after its last observation a connected connector is still
 * considered healthy, as a multiple of its own expected update interval.
 *
 * A multiple rather than a constant because "quiet for 30 seconds" means
 * something very different to a connector that polls every 4 seconds than to
 * one that polls every minute. Three intervals allows a missed tick and a
 * retry before anything is called degraded.
 */
export const HEALTH_SILENCE_INTERVALS = 3;

export type DeriveHealthInput = {
  status: ConnectorStatus;
  /** How often this connector expects to deliver, in ms. Absent for connectors that do not poll. */
  expectedIntervalMs?: number;
  now: number;
};

/**
 * Health for one connector.
 *
 * The ordering of the branches is the design:
 *
 *   - a connector that is not live has no health to report beyond its status;
 *   - a live connector that is failing reports that, even mid-retry;
 *   - a connected connector that has never delivered is `idle`, not healthy —
 *     "connected and has told us nothing" is a real and distinct state, and
 *     showing it as healthy is how a UI ends up implying activity that has
 *     not happened;
 *   - one that delivered recently is healthy; one that has gone quiet past
 *     its own tolerance is degraded.
 */
export function deriveConnectorHealth(input: DeriveHealthInput): ConnectorHealth {
  const { status, expectedIntervalMs, now } = input;

  if (status.kind === "error") return { kind: "failing", label: "Not working" };
  if (!isLiveConnectorStatus(status.kind)) return { kind: "unknown", label: "Not connected" };
  if (status.kind === "reconnecting") return { kind: "degraded", label: "Reconnecting" };
  if (status.kind === "connecting") return { kind: "unknown", label: "Connecting" };

  // Connected, but has said nothing at all yet. Not a fault — a machine with
  // no agent running is exactly this — so it is not "degraded" either.
  if (status.lastObservationAt === undefined) {
    return status.lastError
      ? { kind: "degraded", label: "Connected, last check failed" }
      : { kind: "idle", label: "Connected, nothing observed yet" };
  }

  if (expectedIntervalMs && expectedIntervalMs > 0) {
    const silence = now - status.lastObservationAt;
    if (silence > expectedIntervalMs * HEALTH_SILENCE_INTERVALS) {
      return { kind: "degraded", label: "No recent activity" };
    }
  }

  return { kind: "healthy", label: "Healthy" };
}

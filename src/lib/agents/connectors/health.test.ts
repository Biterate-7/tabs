import { describe, expect, it } from "vitest";
import { deriveConnectorHealth, HEALTH_SILENCE_INTERVALS } from "./health";
import { connectorError } from "./types";
import type { ConnectorStatus } from "./types";

const T0 = 1_700_000_000_000;
const INTERVAL = 4_000;

function status(over: Partial<ConnectorStatus> & { kind: ConnectorStatus["kind"] }): ConnectorStatus {
  return { since: T0, ...over };
}

describe("health of a connector that is not live", () => {
  it.each(["disconnected", "unavailable", "configuration_required"] as const)(
    "reports %s as having no health rather than as healthy",
    (kind) => {
      const health = deriveConnectorHealth({ status: status({ kind }), now: T0 });
      expect(health.kind).toBe("unknown");
      expect(health.label).toBe("Not connected");
    }
  );

  it("reports a failed connector as failing", () => {
    const health = deriveConnectorHealth({
      status: status({ kind: "error", lastError: connectorError("unreachable") }),
      now: T0,
    });
    expect(health.kind).toBe("failing");
  });
});

describe("health of a live connector", () => {
  it("is idle — not healthy — when connected and nothing has been observed", () => {
    // "Connected and has told us nothing" is a real state. Reporting it as
    // healthy is how a UI starts implying activity that has not happened.
    const health = deriveConnectorHealth({
      status: status({ kind: "connected" }),
      expectedIntervalMs: INTERVAL,
      now: T0,
    });

    expect(health.kind).toBe("idle");
  });

  it("is degraded when connected but the last check failed", () => {
    const health = deriveConnectorHealth({
      status: status({ kind: "connected", lastError: connectorError("timeout") }),
      expectedIntervalMs: INTERVAL,
      now: T0,
    });

    expect(health.kind).toBe("degraded");
  });

  it("is healthy shortly after an observation", () => {
    const health = deriveConnectorHealth({
      status: status({ kind: "connected", lastObservationAt: T0 }),
      expectedIntervalMs: INTERVAL,
      now: T0 + INTERVAL,
    });

    expect(health.kind).toBe("healthy");
    expect(health.label).toBe("Healthy");
  });

  it("tolerates a missed tick and a retry before calling anything degraded", () => {
    const stillFine = deriveConnectorHealth({
      status: status({ kind: "connected", lastObservationAt: T0 }),
      expectedIntervalMs: INTERVAL,
      now: T0 + INTERVAL * HEALTH_SILENCE_INTERVALS,
    });
    expect(stillFine.kind).toBe("healthy");

    const tooQuiet = deriveConnectorHealth({
      status: status({ kind: "connected", lastObservationAt: T0 }),
      expectedIntervalMs: INTERVAL,
      now: T0 + INTERVAL * HEALTH_SILENCE_INTERVALS + 1,
    });
    expect(tooQuiet.kind).toBe("degraded");
  });

  it("scales tolerance to the connector's own interval", () => {
    const silence = 60_000;

    // The same silence is fine for a slow connector and a problem for a fast
    // one, which is why the threshold is a multiple rather than a constant.
    expect(
      deriveConnectorHealth({
        status: status({ kind: "connected", lastObservationAt: T0 }),
        expectedIntervalMs: 60_000,
        now: T0 + silence,
      }).kind
    ).toBe("healthy");

    expect(
      deriveConnectorHealth({
        status: status({ kind: "connected", lastObservationAt: T0 }),
        expectedIntervalMs: 1_000,
        now: T0 + silence,
      }).kind
    ).toBe("degraded");
  });

  it("never calls a connector quiet when it does not poll", () => {
    const health = deriveConnectorHealth({
      status: status({ kind: "connected", lastObservationAt: T0 }),
      now: T0 + 10 * 60 * 60 * 1000,
    });

    // No expected interval means there is no such thing as "late".
    expect(health.kind).toBe("healthy");
  });

  it("reports connecting and reconnecting distinctly", () => {
    expect(deriveConnectorHealth({ status: status({ kind: "connecting" }), now: T0 }).kind).toBe(
      "unknown"
    );
    expect(
      deriveConnectorHealth({ status: status({ kind: "reconnecting" }), now: T0 }).kind
    ).toBe("degraded");
  });
});

describe("purity", () => {
  it("returns the same answer for the same inputs", () => {
    const input = {
      status: status({ kind: "connected" as const, lastObservationAt: T0 }),
      expectedIntervalMs: INTERVAL,
      now: T0 + 1000,
    };

    expect(deriveConnectorHealth(input)).toEqual(deriveConnectorHealth(input));
  });
});

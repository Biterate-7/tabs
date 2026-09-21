import { describe, expect, it } from "vitest";
import {
  createCorrelationRegistry,
  isControlled,
  resolveControlRun,
  toCorrelationView,
} from "./correlation";

const T0 = 1_700_000_000_000;

/**
 * Correlation.
 *
 * The distinction under test throughout: **control** is what TabDump asked
 * for, **observation** is what TabDump saw, and a correlation is evidence
 * that the two describe the same provider session. The failure this suite
 * exists to prevent is a registry that quietly labels observed activity as
 * controlled because it is convenient.
 */

describe("joining the two planes", () => {
  it("extends a control record when the provider finally reveals its id", () => {
    // The real sequence. A session is created, a run starts, and only then —
    // on the provider's first frame — does its own session id arrive.
    const registry = createCorrelationRegistry();

    const created = registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1" },
      T0
    );
    registry.update(created.id, { controlRunId: "cr1" }, T0 + 1);
    registry.update(created.id, { providerSessionId: "prov-abc" }, T0 + 2);

    expect(registry.size()).toBe(1);
    expect(registry.controlRunFor("claude-code", "prov-abc")).toBe("cr1");
  });

  it("merges an observation into the control record it matches", () => {
    const registry = createCorrelationRegistry();

    const control = registry.register(
      {
        provider: "claude-code",
        origin: "control",
        controlSessionId: "cs1",
        controlRunId: "cr1",
        providerSessionId: "prov-abc",
      },
      T0
    );

    // Observation arrives independently and knows nothing about control. The
    // provider session id is the only thing both sides have.
    const observed = registry.register(
      {
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov-abc",
        observationAgentId: "agent-1",
        observationRunId: "run-7",
      },
      T0 + 10
    );

    expect(observed.id).toBe(control.id);
    expect(registry.size()).toBe(1);
    expect(observed.observationRunId).toBe("run-7");
    expect(observed.controlRunId).toBe("cr1");
    // Origin is fixed at registration. This record was born of control, and
    // saying so is how a reader knows TabDump started it.
    expect(observed.origin).toBe("control");
  });

  it("gives an externally started session no fabricated control run", () => {
    // Somebody opened a terminal and ran Claude Code. TabDump can see it and
    // did not start it, and the record has to say exactly that.
    const registry = createCorrelationRegistry();

    const observed = registry.register(
      {
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov-external",
        observationAgentId: "agent-1",
        observationRunId: "run-9",
      },
      T0
    );

    expect(observed.controlRunId).toBeUndefined();
    expect(observed.controlSessionId).toBeUndefined();
    expect(isControlled(observed)).toBe(false);
    expect(registry.controlRunFor("claude-code", "prov-external")).toBeUndefined();
  });

  it("does not join two providers that happen to share a session id", () => {
    const registry = createCorrelationRegistry();

    registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1", providerSessionId: "x" },
      T0
    );
    const other = registry.register(
      { provider: "openai-codex", origin: "observation", providerSessionId: "x" },
      T0
    );

    expect(registry.size()).toBe(2);
    expect(other.controlSessionId).toBeUndefined();
  });

  it("treats a session created but never run as uncontrolled until it runs", () => {
    const registry = createCorrelationRegistry();
    const record = registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1" },
      T0
    );

    expect(isControlled(record)).toBe(false);
    expect(isControlled(registry.update(record.id, { controlRunId: "cr1" }, T0)!)).toBe(true);
  });
});

describe("what a patch may not do", () => {
  it("never erases what is already known", () => {
    const registry = createCorrelationRegistry();
    const record = registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1", controlRunId: "cr1" },
      T0
    );

    registry.update(record.id, { providerSessionId: "" }, T0 + 1);
    registry.update(record.id, {}, T0 + 2);

    expect(registry.byId(record.id)?.controlRunId).toBe("cr1");
  });

  it("leaves the record untouched when nothing changed", () => {
    const registry = createCorrelationRegistry();
    const record = registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1" },
      T0
    );

    const same = registry.update(record.id, { controlSessionId: "cs1" }, T0 + 100);
    expect(same?.updatedAt).toBe(T0);
  });

  it("refuses to update a record it does not hold", () => {
    const registry = createCorrelationRegistry();
    expect(registry.update("nothing", { controlRunId: "cr1" }, T0)).toBeUndefined();
  });
});

describe("lookups", () => {
  it("finds records by every identifier it holds", () => {
    const registry = createCorrelationRegistry();
    registry.register(
      {
        provider: "claude-code",
        origin: "control",
        controlSessionId: "cs1",
        controlRunId: "cr1",
        providerSessionId: "prov",
        observationAgentId: "agent-1",
      },
      T0
    );

    expect(registry.byControlSession("cs1")).toHaveLength(1);
    expect(registry.byControlRun("cr1")?.providerSessionId).toBe("prov");
    expect(registry.byObservationAgent("agent-1")).toHaveLength(1);
    expect(registry.byProviderSession("claude-code", "prov")?.controlRunId).toBe("cr1");
  });

  it("resolves a control run from views alone, for a caller with no registry", () => {
    // The browser's half. The future command centre renders observed runs and
    // needs to know which of them TabDump drove, holding only what came over
    // the wire.
    const views = [
      toCorrelationView({
        id: "1",
        provider: "claude-code",
        origin: "control",
        controlRunId: "cr1",
        providerSessionId: "prov-a",
        firstSeenAt: T0,
        updatedAt: T0,
      }),
      toCorrelationView({
        id: "2",
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov-b",
        firstSeenAt: T0,
        updatedAt: T0,
      }),
    ];

    expect(resolveControlRun(views, "claude-code", "prov-a")).toBe("cr1");
    expect(resolveControlRun(views, "claude-code", "prov-b")).toBeUndefined();
    expect(resolveControlRun(views, "openai-codex", "prov-a")).toBeUndefined();
  });

  it("does not put its internal key on the wire", () => {
    const view = toCorrelationView({
      id: "internal-1",
      provider: "claude-code",
      origin: "control",
      firstSeenAt: T0,
      updatedAt: T0,
    });

    expect(Object.keys(view)).not.toContain("id");
  });
});

describe("removal", () => {
  it("forgets a control record when its session is disposed", () => {
    const registry = createCorrelationRegistry();
    registry.register(
      { provider: "claude-code", origin: "control", controlSessionId: "cs1" },
      T0
    );

    expect(registry.removeControlSession("cs1")).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it("keeps the observation half of a record control merely joined", () => {
    // The agent is still on disk and the next poll will still recognise it.
    // Only the control link goes.
    const registry = createCorrelationRegistry();
    const record = registry.register(
      {
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov",
        observationRunId: "run-1",
      },
      T0
    );
    registry.update(record.id, { controlSessionId: "cs1", controlRunId: "cr1" }, T0 + 1);

    registry.removeControlSession("cs1");

    const after = registry.byId(record.id);
    expect(after?.observationRunId).toBe("run-1");
    expect(after?.controlRunId).toBeUndefined();
    expect(after?.controlSessionId).toBeUndefined();
  });
});

describe("bounds", () => {
  it("evicts the least recently updated rather than growing forever", () => {
    const registry = createCorrelationRegistry();

    for (let index = 0; index < 520; index += 1) {
      registry.register(
        { provider: "claude-code", origin: "observation", providerSessionId: `p${index}` },
        T0 + index
      );
    }

    expect(registry.size()).toBeLessThanOrEqual(500);
    expect(registry.byProviderSession("claude-code", "p0")).toBeUndefined();
    expect(registry.byProviderSession("claude-code", "p519")).toBeDefined();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { ingestObservation } from "@/lib/agents/adapter";
import { createAgent } from "@/lib/agents/registry";
import { findRunByExternalId } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { resolveControlRun, toCorrelationView } from "./correlation";
import { createRuntimeHost } from "./host";
import { createScriptedAdapter } from "./__fixtures__/adapter";
import type { AgentState } from "@/lib/agents/types";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { ScriptedAdapter } from "./__fixtures__/adapter";

const T0 = 1_700_000_000_000;
const ALICE: RuntimeActor = { id: "account:alice" };

const ALLOWED: ExecutionGateResult = {
  allowed: true,
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};

/**
 * Where control meets observation.
 *
 * ## The three things being kept apart
 *
 *     CONTROL      TabDump asked an agent to do something, and holds the
 *                  session and run ids it minted to do so.
 *
 *     OBSERVATION  TabDump watched an agent do something, and holds the
 *                  domain run that ingestion minted from a transcript.
 *
 *     CORRELATION  Evidence that those describe the same provider session.
 *                  The evidence is the provider session id, which is the one
 *                  identifier both planes independently arrive at:
 *                  `AgentRun.externalId` on one side, the id the provider
 *                  reveals on its stream on the other.
 *
 * This suite drives the **real** ingestion path — `ingestObservation` against
 * a real `AgentState` — rather than a stand-in, because the claim being made
 * is about the seam between two existing systems and a fake on either side
 * would prove nothing about it.
 */

let adapter: ScriptedAdapter;

beforeEach(() => {
  adapter = createScriptedAdapter({ now: () => T0 });
});

function host() {
  let counter = 0;
  return createRuntimeHost({
    gate: ALLOWED,
    resolveAdapter: () => adapter,
    providers: ["claude-code"],
    now: () => T0,
    createId: () => `id${++counter}`,
    runtimeId: "runtime-1",
  });
}

function seeded(): { state: AgentState; agentId: string } {
  const agent = createAgent(
    emptyAgentState(),
    { provider: "claude-code", name: "Claude Code" },
    T0
  );
  if (!agent.ok) throw new Error("fixture failed");
  return { state: agent.state, agentId: agent.agent.id };
}

describe("a session TabDump started", () => {
  it("is recognisable in the observation plane through the provider's own id", async () => {
    const runtime = host();

    const started = await runtime.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
    });
    if (!started.ok) throw new Error("start failed");

    // The provider reveals its own session id on its first frame.
    adapter.revealProviderSession(started.value.sessionId, "prov-abc");
    adapter.emit({ sessionId: started.value.sessionId, kind: "session_started" });

    // Meanwhile, entirely separately, the observation pipeline reads a
    // transcript on disk and ingests it. It knows the provider session id and
    // nothing at all about control.
    const { state, agentId } = seeded();
    const ingested = ingestObservation(state, {
      agentId,
      observation: {
        provider: "claude-code",
        externalId: "prov-abc",
        workspaceId: "w1",
        title: "Refactoring the parser",
      },
      now: T0,
    });
    if (!ingested.ok) throw new Error("ingest failed");

    const observedRun = findRunByExternalId(ingested.state, agentId, "prov-abc");
    expect(observedRun).toBeDefined();

    // The correlation is made after the fact, from the one identifier both
    // sides have. Nothing about ingestion had to change to make it possible.
    expect(runtime.correlations.controlRunFor("claude-code", "prov-abc")).toBe(
      started.value.activeRunId
    );

    const linked = await runtime.execute(ALICE, {
      name: "link_observation",
      sessionId: started.value.sessionId,
      observationAgentId: agentId,
      observationRunId: observedRun!.id,
    });

    expect(linked.ok && linked.value).toMatchObject({
      controlRunId: started.value.activeRunId,
      providerSessionId: "prov-abc",
      observationRunId: observedRun!.id,
      origin: "control",
    });
  });

  it("can be resolved by a browser holding only what came over the wire", async () => {
    const runtime = host();
    const started = await runtime.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
    });
    if (!started.ok) throw new Error("start failed");

    adapter.revealProviderSession(started.value.sessionId, "prov-abc");
    adapter.emit({ sessionId: started.value.sessionId, kind: "session_started" });

    const listed = await runtime.execute(ALICE, { name: "list_sessions" });
    const correlations = listed.ok ? listed.value.correlations : [];

    // The future command centre renders an observed run and asks: did we
    // drive this? It answers from the views alone.
    expect(resolveControlRun(correlations, "claude-code", "prov-abc")).toBe(
      started.value.activeRunId
    );
  });
});

describe("a session somebody else started", () => {
  it("is ingested and graphed with no control run invented for it", () => {
    // Somebody opened a terminal and ran Claude Code. Observation must work
    // exactly as it always has, and must not acquire a control identity it
    // does not have.
    const runtime = host();
    const { state, agentId } = seeded();

    const ingested = ingestObservation(state, {
      agentId,
      observation: {
        provider: "claude-code",
        externalId: "prov-external",
        workspaceId: "w1",
        title: "Something a person ran",
        activity: "Reading src/index.ts",
      },
      now: T0,
    });
    if (!ingested.ok) throw new Error("ingest failed");

    const run = findRunByExternalId(ingested.state, agentId, "prov-external");
    expect(run?.title).toBe("Something a person ran");
    expect(run?.currentActivity).toBe("Reading src/index.ts");

    // Nothing in the control plane claims it.
    expect(runtime.correlations.controlRunFor("claude-code", "prov-external")).toBeUndefined();

    const recorded = runtime.correlations.register(
      {
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov-external",
        observationAgentId: agentId,
        observationRunId: run!.id,
      },
      T0
    );

    expect(recorded.controlRunId).toBeUndefined();
    expect(recorded.controlSessionId).toBeUndefined();
    expect(toCorrelationView(recorded).origin).toBe("observation");
  });

  it("keeps working with no runtime host in existence at all", () => {
    // The property that makes control an additional source of knowledge
    // rather than a prerequisite: this is a hosted deployment's permanent
    // state, and the observation plane has to be complete without it.
    const { state, agentId } = seeded();

    const ingested = ingestObservation(state, {
      agentId,
      observation: {
        provider: "claude-code",
        externalId: "prov-lonely",
        workspaceId: "w1",
        status: "working",
      },
      now: T0,
    });

    expect(ingested.ok).toBe(true);
    expect(
      ingested.ok && findRunByExternalId(ingested.state, agentId, "prov-lonely")?.status
    ).toBe("working");
  });
});

describe("what the two planes do not share", () => {
  it("does not let a control run be attributed to the wrong observed session", async () => {
    const runtime = host();

    const a = await runtime.execute(ALICE, { name: "create_session", provider: "claude-code" });
    const b = await runtime.execute(ALICE, { name: "create_session", provider: "claude-code" });
    if (!a.ok || !b.ok) throw new Error("start failed");

    adapter.revealProviderSession(a.value.sessionId, "prov-a");
    adapter.revealProviderSession(b.value.sessionId, "prov-b");
    adapter.emit({ sessionId: a.value.sessionId, kind: "session_started" });
    adapter.emit({ sessionId: b.value.sessionId, kind: "session_started" });

    expect(runtime.correlations.controlRunFor("claude-code", "prov-a")).toBe(a.value.activeRunId);
    expect(runtime.correlations.controlRunFor("claude-code", "prov-b")).toBe(b.value.activeRunId);
    expect(a.value.activeRunId).not.toBe(b.value.activeRunId);
  });

  it("forgets a control link when the session is disposed, keeping the observation", async () => {
    const runtime = host();
    const { agentId } = seeded();

    const started = await runtime.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
    });
    if (!started.ok) throw new Error("start failed");

    adapter.revealProviderSession(started.value.sessionId, "prov-abc");
    adapter.emit({ sessionId: started.value.sessionId, kind: "session_started" });
    await runtime.execute(ALICE, {
      name: "link_observation",
      sessionId: started.value.sessionId,
      observationAgentId: agentId,
      observationRunId: "run-1",
    });

    await runtime.execute(ALICE, {
      name: "dispose_session",
      sessionId: started.value.sessionId,
    });

    // The control record went with the session. The observed agent did not —
    // it is still on disk, and the next poll will still recognise it.
    expect(runtime.correlations.controlRunFor("claude-code", "prov-abc")).toBeUndefined();
    expect(runtime.correlations.byObservationAgent(agentId)).toHaveLength(0);
  });
});

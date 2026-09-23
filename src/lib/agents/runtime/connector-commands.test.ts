import { describe, expect, it } from "vitest";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { AgentError, createFakeAgent, flush } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createRuntimeHost } from "./host";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { ProviderDetection, SequencedControlEvent } from "./protocol";

/**
 * The Phase J verbs, end to end through the host: detect, connect, sign in,
 * converse, disconnect — against the real ACP adapter and a scripted agent.
 */

const T0 = 1_700_000_000_000;

const LOCAL: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};

const REMOTE: ExecutionGateResult = {
  allowed: true,
  environment: "remote",
  kind: "remote",
  decision: { allowed: true, kind: "remote" },
} as unknown as ExecutionGateResult;

const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };

const DETECTIONS: ProviderDetection[] = [
  { provider: "gemini", installed: true, transport: "acp", launchable: true, signIn: "unknown" },
];

function build(gate: ExecutionGateResult = LOCAL, handlers = {}) {
  const agent = createFakeAgent({
    "session/new": () => ({ sessionId: "acp-1" }),
    "session/prompt": async (params: Record<string, unknown>, context: { update: (id: string, u: Record<string, unknown>) => void }) => {
      context.update(params.sessionId as string, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the whole answer,\nacross lines." },
      });
      await flush(2);
      return { stopReason: "end_turn" };
    },
    ...handlers,
  });
  const adapters = new Map<string, ReturnType<typeof createAcpControlAdapter>>();
  let counter = 0;
  const host = createRuntimeHost({
    gate,
    resolveAdapter: (provider, ownerId) => {
      if (provider !== "gemini") return undefined;
      const key = `${provider}:${ownerId}`;
      if (!adapters.has(key)) {
        adapters.set(key, createAcpControlAdapter({ provider, launch: agent.launcher, now: () => T0 }));
      }
      return adapters.get(key);
    },
    providers: ["gemini"],
    detect: () => DETECTIONS,
    now: () => T0,
    createId: () => `id${++counter}`,
    runtimeId: "runtime-1",
  });
  return { host, agent };
}

describe("detect_providers", () => {
  it("answers with booleans on a local runtime", async () => {
    const { host } = build();
    const detected = await host.execute(ALICE, { name: "detect_providers" });
    expect(detected).toEqual({ ok: true, value: { thisMachine: true, detections: DETECTIONS } });
  });

  it("reports nothing about a server's software on a remote runtime", async () => {
    const { host } = build(REMOTE);
    const detected = await host.execute(ALICE, { name: "detect_providers" });
    expect(detected).toEqual({ ok: true, value: { thisMachine: false, detections: [] } });
  });
});

describe("connect and sign in", () => {
  it("connects, learns the agent's sign-in methods, and signs in with one", async () => {
    let signedIn = false;
    const { host, agent } = build(LOCAL, {
      "session/new": () => {
        if (!signedIn) throw new AgentError(-32000);
        return { sessionId: "acp-1" };
      },
      authenticate: () => {
        signedIn = true;
        return {};
      },
    });

    const connected = await host.execute(ALICE, { name: "connect_provider", provider: "gemini" });
    expect(connected).toMatchObject({
      ok: true,
      value: {
        provider: "gemini",
        connection: "connected",
        authentication: "unknown",
        authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
      },
    });

    // A session before sign-in is refused with the sentence that says so.
    const refused = await host.execute(ALICE, { name: "create_session", provider: "gemini" });
    expect(refused).toMatchObject({ ok: false, error: { code: "authentication_required" } });

    const status = await host.execute(ALICE, { name: "get_status" });
    expect(status.ok && status.value.providers[0].authentication).toBe("required");

    const authed = await host.execute(ALICE, {
      name: "authenticate_provider",
      provider: "gemini",
      methodId: "oauth-personal",
    });
    expect(authed).toMatchObject({ ok: true, value: { authentication: "authenticated" } });
    expect(agent.received.filter((message) => message.method === "authenticate")).toHaveLength(1);
  });

  it("refuses a sign-in method the agent did not advertise", async () => {
    const { host } = build();
    await host.execute(ALICE, { name: "connect_provider", provider: "gemini" });
    const refused = await host.execute(ALICE, {
      name: "authenticate_provider",
      provider: "gemini",
      methodId: "made-up",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("refuses a provider with no adapter", async () => {
    const { host } = build();
    expect(await host.execute(ALICE, { name: "connect_provider", provider: "custom" })).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable" },
    });
  });

  it("refuses everything but status on a runtime that may not execute", async () => {
    const { host } = build({
      allowed: false,
      kind: "hosted",
      decision: { allowed: false, kind: "hosted", reason: "hosted-platform" },
      detail: "no",
    } as ExecutionGateResult);
    expect(await host.execute(ALICE, { name: "connect_provider", provider: "gemini" })).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
  });
});

describe("a conversation through the host", () => {
  it("journals the user's words and the agent's whole reply, in order", async () => {
    const { host } = build();
    const created = await host.execute(ALICE, { name: "create_session", provider: "gemini" });
    if (!created.ok) throw new Error(created.error.code);
    const sessionId = created.value.sessionId;

    const sent = await host.execute(ALICE, { name: "send_message", sessionId, text: "Explain\nthis" });
    expect(sent.ok).toBe(true);
    await flush(20);

    const read = await host.execute(ALICE, { name: "get_events", sessionId });
    if (!read.ok) throw new Error(read.error.code);
    const events = read.value.events as SequencedControlEvent[];

    const spine = events.filter((event) => event.kind !== "message_delta").map((event) => event.kind);
    expect(spine).toEqual(["session_started", "message_sent", "message_received", "run_completed"]);
    expect(events.find((event) => event.kind === "message_sent")?.text).toBe("Explain\nthis");
    expect(events.find((event) => event.kind === "message_received")?.text).toBe(
      "Here is the whole answer,\nacross lines."
    );
  });

  it("keeps one actor's agent connection away from another", async () => {
    const { host } = build();
    const created = await host.execute(ALICE, { name: "create_session", provider: "gemini" });
    if (!created.ok) throw new Error(created.error.code);

    expect(
      await host.execute(BOB, { name: "send_message", sessionId: created.value.sessionId, text: "hi" })
    ).toMatchObject({ ok: false });
    // Bob disconnecting Gemini ends nothing of Alice's.
    await host.execute(BOB, { name: "disconnect_provider", provider: "gemini" });
    const still = await host.execute(ALICE, { name: "get_session", sessionId: created.value.sessionId });
    expect(still.ok).toBe(true);
  });

  it("ends the actor's sessions with the provider on disconnect", async () => {
    const { host, agent } = build();
    const created = await host.execute(ALICE, { name: "create_session", provider: "gemini" });
    if (!created.ok) throw new Error(created.error.code);

    const disconnected = await host.execute(ALICE, { name: "disconnect_provider", provider: "gemini" });
    expect(disconnected).toMatchObject({ ok: true, value: { connection: "disconnected" } });

    const gone = await host.execute(ALICE, { name: "get_session", sessionId: created.value.sessionId });
    expect(gone).toMatchObject({ ok: false, error: { code: "session_not_found" } });
    expect(agent.received.some((message) => message.method === "session/cancel")).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_PROVIDERS, platformProvider } from "./catalog";
import { buildSessionModel, buildTranscript, liveActivity } from "./chat";
import { createPlatformConnector } from "./connector";
import { connectionPhase, defaultApprovedScopes, stepFor } from "./lifecycle";
import {
  AGENT_ROSTER_KEY,
  EMPTY_ROSTER,
  agentIdFor,
  approveAgent,
  forgetAgent,
  grantWithinApproval,
  loadAgentRoster,
  recordAgentSession,
  saveAgentRoster,
} from "./roster";
import { scopedKey } from "@/lib/storage/namespace";
import type { RuntimeClient } from "@/lib/agents/runtime/client";
import type {
  ProviderDetection,
  RuntimeCommand,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

const T0 = 1_700_000_000_000;
const gemini = platformProvider("gemini")!;
const claude = platformProvider("claude-code")!;
const custom = platformProvider("custom")!;

const INSTALLED: ProviderDetection = {
  provider: "gemini",
  installed: true,
  transport: "acp",
  launchable: true,
};

describe("the catalogue", () => {
  it("covers every provider exactly once, and only the MCP client cannot chat", () => {
    expect(PLATFORM_PROVIDERS.map((entry) => entry.provider)).toEqual([
      "claude-code",
      "openai-codex",
      "gemini",
      "grok",
      "custom",
    ]);
    expect(PLATFORM_PROVIDERS.filter((entry) => !entry.chat).map((entry) => entry.provider)).toEqual(["custom"]);
  });
});

describe("the connection lifecycle", () => {
  it("walks the questions in order for an ACP agent", () => {
    const base = { provider: gemini, executable: true, local: true };
    expect(connectionPhase({ ...base, executable: false })).toBe("runtime_unavailable");
    expect(connectionPhase(base)).toBe("unknown");
    expect(connectionPhase({ ...base, detection: { ...INSTALLED, installed: false, launchable: false } })).toBe(
      "not_installed"
    );
    expect(connectionPhase({ ...base, detection: { ...INSTALLED, launchable: false } })).toBe("needs_adapter");
    expect(connectionPhase({ ...base, detection: INSTALLED })).toBe("detected");
    expect(
      connectionPhase({
        ...base,
        detection: INSTALLED,
        status: { provider: "gemini", connection: "connected", available: true, authentication: "required", capabilities: [] },
      })
    ).toBe("sign_in_required");
    expect(
      connectionPhase({
        ...base,
        detection: INSTALLED,
        status: { provider: "gemini", connection: "connected", available: true, authentication: "authenticated", capabilities: [] },
      })
    ).toBe("awaiting_approval");
    expect(
      connectionPhase({
        ...base,
        detection: INSTALLED,
        status: { provider: "gemini", connection: "connected", available: true, authentication: "authenticated", capabilities: [] },
        approvedScopes: ["read_workspace"],
      })
    ).toBe("connected");
  });

  it("never claims an ACP agent on a remote runtime — it runs on the user's machine", () => {
    expect(connectionPhase({ provider: gemini, executable: true, local: false })).toBe("runtime_unavailable");
  });

  it("asks for the user's own key before Claude can connect", () => {
    expect(
      connectionPhase({ provider: claude, executable: true, local: false, providerKeyConnected: false })
    ).toBe("sign_in_required");
  });

  it("does not need the runtime at all for an MCP client", () => {
    expect(connectionPhase({ provider: custom, executable: false, local: false, mcpTokenIssued: false })).toBe(
      "sign_in_required"
    );
    expect(connectionPhase({ provider: custom, executable: false, local: false })).toBe("awaiting_approval");
    expect(connectionPhase({ provider: custom, executable: false, local: false, mcpTokenIssued: true })).toBe(
      "awaiting_approval"
    );
  });

  it("maps each phase to the connect step it needs", () => {
    expect(stepFor("unknown")).toBe("detect");
    expect(stepFor("sign_in_required")).toBe("sign_in");
    expect(stepFor("awaiting_approval")).toBe("approve");
    expect(stepFor("connected")).toBe("done");
  });

  it("approves reading by default and never writing or running", () => {
    expect(defaultApprovedScopes(gemini)).toEqual(["read_workspace", "read_project"]);
    expect(defaultApprovedScopes(custom)).toEqual(["read_workspace"]);
  });
});

describe("the roster", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips identities under an account-scoped key", () => {
    const roster = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "Gemini CLI", scopes: ["read_workspace"], now: T0 });
    expect(saveAgentRoster(roster)).toBe(true);
    expect(window.localStorage.getItem(scopedKey(AGENT_ROSTER_KEY))).not.toBeNull();
    expect(loadAgentRoster().agents).toEqual([
      {
        id: agentIdFor("gemini"),
        provider: "gemini",
        name: "Gemini CLI",
        connectedAt: T0,
        approvedScopes: ["read_workspace"],
        approvedAt: T0,
      },
    ]);
  });

  it("drops a hand-edited entry rather than trusting it, and removes unknown scopes", () => {
    window.localStorage.setItem(
      scopedKey(AGENT_ROSTER_KEY),
      JSON.stringify({
        version: 1,
        agents: [
          { id: "agent:grok", provider: "grok", name: "Grok", connectedAt: T0, approvedAt: T0, approvedScopes: ["run_anything", "read_workspace"] },
          { id: "not-derived", provider: "gemini", name: "x", connectedAt: T0, approvedAt: T0, approvedScopes: [] },
          { id: "agent:evil", provider: "evil", name: "x", connectedAt: T0, approvedAt: T0, approvedScopes: [] },
        ],
      })
    );
    const loaded = loadAgentRoster();
    expect(loaded.agents.map((agent) => agent.provider)).toEqual(["grok"]);
    expect(loaded.agents[0].approvedScopes).toEqual(["read_workspace"]);
  });

  it("writes no credential-shaped field even when handed one", () => {
    const roster = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: [], now: T0 });
    const tainted = { version: 1 as const, agents: [{ ...roster.agents[0], apiKey: "sk-secret", token: "tdmcp_x" }] };
    saveAgentRoster(tainted);
    const stored = window.localStorage.getItem(scopedKey(AGENT_ROSTER_KEY))!;
    expect(stored).not.toContain("sk-secret");
    expect(stored).not.toContain("tdmcp_");
  });

  it("re-approval replaces scopes, forgetting removes, sessions record their workspace", () => {
    let roster = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: ["read_workspace", "write_project"], now: T0 });
    roster = approveAgent(roster, { provider: "gemini", name: "G", scopes: ["read_workspace"], now: T0 + 1 });
    expect(roster.agents[0].approvedScopes).toEqual(["read_workspace"]);
    expect(roster.agents[0].connectedAt).toBe(T0);

    roster = recordAgentSession(roster, { provider: "gemini", sessionId: "s1", workspaceId: "w1", now: T0 + 2 });
    expect(roster.agents[0]).toMatchObject({ lastSessionId: "s1", workspaceId: "w1", lastActiveAt: T0 + 2 });

    expect(forgetAgent(roster, "gemini").agents).toEqual([]);
  });

  it("checks a project's grant against what the agent was approved for", () => {
    const agent = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: ["read_project"], now: T0 }).agents[0];
    expect(grantWithinApproval(agent, ["read_project"])).toBe(true);
    expect(grantWithinApproval(agent, ["read_project", "write_project"])).toBe(false);
  });
});

function event(sequence: number, over: Partial<SequencedControlEvent>): SequencedControlEvent {
  return {
    id: `e${sequence}`,
    sessionId: "s1",
    provider: "gemini",
    kind: "tool_started",
    timestamp: T0 + sequence,
    summary: "",
    sequence,
    ...over,
  } as SequencedControlEvent;
}

describe("the transcript", () => {
  it("joins streamed pieces, then replaces them with the whole reply in place", () => {
    const streaming = buildTranscript([
      event(1, { kind: "message_sent", summary: "hi", text: "hi\nthere" }),
      event(2, { kind: "message_delta", messageId: "m1", text: "Hel" }),
      event(3, { kind: "message_delta", messageId: "m1", text: "lo" }),
    ]);
    expect(streaming).toMatchObject([
      { type: "message", role: "user", text: "hi\nthere", streaming: false },
      { type: "message", role: "agent", text: "Hello", streaming: true },
    ]);

    const done = buildTranscript([
      event(1, { kind: "message_sent", summary: "hi", text: "hi" }),
      event(2, { kind: "message_delta", messageId: "m1", text: "Hel" }),
      event(3, { kind: "tool_started", tool: { name: "Read" } }),
      event(4, { kind: "message_received", messageId: "m1", summary: "Hello.", text: "Hello." }),
      event(5, { kind: "message_delta", messageId: "m1", text: "late" }),
    ]);
    expect(done.map((item) => (item.type === "message" ? `${item.role}:${item.text}` : item.event.kind))).toEqual([
      "user:hi",
      "agent:Hello.",
      "tool_started",
    ]);
  });

  it("shows a non-streaming provider's reply whole, and falls back to the summary", () => {
    const items = buildTranscript([event(1, { kind: "message_received", summary: "Short." })]);
    expect(items).toMatchObject([{ type: "message", role: "agent", text: "Short.", streaming: false }]);
  });

  it("stops marking pieces as arriving once the run was cancelled", () => {
    const items = buildTranscript([
      event(1, { kind: "message_delta", messageId: "m1", text: "Half" }),
      event(2, { kind: "run_cancelled", summary: "Run cancelled." }),
    ]);
    expect(items[0]).toMatchObject({ streaming: false, text: "Half" });
  });
});

function view(over: Partial<RuntimeSessionView> = {}): RuntimeSessionView {
  return {
    sessionId: "s1",
    provider: "gemini",
    status: "running",
    runIds: [],
    awaitingApproval: false,
    cancellable: true,
    resumable: false,
    latestSequence: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe("the unified session", () => {
  it("says what the agent is doing from the status first, then the newest event", () => {
    expect(liveActivity(undefined)).toBe("No session");
    expect(liveActivity(view({ status: "waiting_for_approval" }))).toBe("Waiting for your approval");
    expect(liveActivity(view({ status: "ready" }))).toBe("Idle");
    expect(liveActivity(view(), [event(1, { kind: "message_delta", messageId: "m", text: "x" })])).toBe("Replying…");
    expect(
      liveActivity(view(), [event(1, { kind: "command_started", tool: { name: "Command", description: "Running a command" } })])
    ).toBe("Running a command");
  });

  it("associates a session with its workspace, from the session or the agent", () => {
    const agent = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: [], now: T0 }).agents[0];
    expect(buildSessionModel({ view: view({ workspaceId: "w1" }), events: [], approvals: [] }).workspaceId).toBe("w1");
    expect(
      buildSessionModel({ view: view(), events: [], approvals: [], agent: { ...agent, workspaceId: "w2" } }).workspaceId
    ).toBe("w2");
  });
});

describe("the connector", () => {
  function fakeClient() {
    const sent: RuntimeCommand[] = [];
    const client = {
      runtimeId: () => "r1",
      reset: () => {},
      status: async () => ({
        ok: true,
        value: {
          environment: "local",
          executable: true,
          runtimeId: "r1",
          providers: [
            { provider: "gemini", connection: "connected", available: true, authentication: "authenticated", capabilities: ["message"] },
          ],
        },
      }),
      send: async (command: RuntimeCommand) => {
        sent.push(command);
        if (command.name === "detect_providers") {
          return { ok: true, value: { thisMachine: true, detections: [INSTALLED] } };
        }
        return { ok: true, value: {} };
      },
    } as unknown as RuntimeClient;
    return { client, sent };
  }

  it("maps every lifecycle method onto one protocol command, for any provider", async () => {
    const { client, sent } = fakeClient();
    const connector = createPlatformConnector("gemini", client);
    const agent = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: ["read_workspace", "read_project"], now: T0 }).agents[0];

    expect(await connector.detect()).toEqual(INSTALLED);
    await connector.connect();
    await connector.authenticate("oauth-personal");
    await connector.createSession({ agent, projectId: "p1", projectScopes: ["read_project"], workspaceId: "w1" });
    await connector.sendMessage("s1", "hello");
    expect(await connector.capabilities()).toEqual(["message"]);
    await connector.disconnect();

    expect(sent).toEqual([
      { name: "detect_providers" },
      { name: "connect_provider", provider: "gemini" },
      { name: "authenticate_provider", provider: "gemini", methodId: "oauth-personal" },
      { name: "create_session", provider: "gemini", projectId: "p1", workspaceId: "w1" },
      { name: "send_message", sessionId: "s1", text: "hello" },
      { name: "disconnect_provider", provider: "gemini" },
    ]);
  });

  it("refuses to start an agent where the project grants more than it was approved for", async () => {
    const { client, sent } = fakeClient();
    const connector = createPlatformConnector("gemini", client);
    const agent = approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "G", scopes: ["read_project"], now: T0 }).agents[0];

    const refused = await connector.createSession({ agent, projectId: "p1", projectScopes: ["read_project", "run_commands"] });
    expect(refused).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(sent).toEqual([]);
  });

  it("never sends a runtime command for an MCP client — TabDump does not start it", async () => {
    const { client, sent } = fakeClient();
    const connector = createPlatformConnector("custom", client);
    const agent = approveAgent(EMPTY_ROSTER, { provider: "custom", name: "C", scopes: ["read_workspace"], now: T0 }).agents[0];

    expect(await connector.detect()).toBeUndefined();
    expect(await connector.connect()).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await connector.createSession({ agent })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(sent).toEqual([]);
  });
});

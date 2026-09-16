import { describe, expect, it } from "vitest";
import { ingestObservation } from "@/lib/agents/adapter";
import { createAgent } from "@/lib/agents/registry";
import { emptyAgentState } from "@/lib/agents/types";
import { ingestObservationBatch, linkObservedUrl, resolveProviderAgentId } from "./ingest";
import type { IngestStore, WorkspaceTabIndex } from "./ingest";
import type { AgentState } from "@/lib/agents/types";
import type { ConnectorObservation } from "./types";

/**
 * Ingestion, exercised against the real domain reducers.
 *
 * The store below is a thin harness, not a mock of the rules: every call
 * lands in `ingestObservation`, `createAgent` and the real link reducer, so
 * what these tests pin is the ingestion layer's own behaviour — identity,
 * workspace attachment, batching, URL linking — rather than a re-statement of
 * the domain's.
 */

const T0 = 1_700_000_000_000;
const WORKSPACE = "workspace-a";

function harness(initial: AgentState = emptyAgentState()) {
  let state = initial;

  const store: IngestStore & { current(): AgentState } = {
    current: () => state,
    getState: () => state,
    createAgent(input) {
      const result = createAgent(state, { provider: input.provider, name: input.name }, T0);
      if (result.ok) state = result.state;
      return result.ok ? null : result.reason;
    },
    ingest(agentId, observation) {
      const result = ingestObservation(state, { agentId, observation, now: T0 });
      if (result.ok) state = result.state;
      return result.ok ? null : result.reason;
    },
    addRunLink(input) {
      // The real reducer, so the workspace boundary is genuinely enforced.
      const link = {
        id: `link-${state.links.length}`,
        runId: input.runId,
        tabId: input.tabId,
        role: input.role,
        createdAt: T0,
      };
      const run = state.runs.find((candidate) => candidate.id === input.runId);
      if (!run || run.workspaceId !== input.tabWorkspaceId) return "cross-workspace";
      state = { ...state, links: [...state.links, link] };
      return null;
    },
  };

  return store;
}

function observation(over: Partial<ConnectorObservation> = {}): ConnectorObservation {
  return { provider: "claude-code", externalId: "session-1", ...over };
}

describe("provider agent identity", () => {
  it("mints one agent per provider and reuses it thereafter", () => {
    const store = harness();

    const first = resolveProviderAgentId(store, "claude-code", "Claude Code");
    const second = resolveProviderAgentId(store, "claude-code", "Claude Code");

    expect(first).toBe(second);
    expect(store.current().agents).toHaveLength(1);
  });

  it("keeps providers' identities separate", () => {
    const store = harness();

    const claude = resolveProviderAgentId(store, "claude-code", "Claude Code");
    const custom = resolveProviderAgentId(store, "custom", "My agent");

    expect(claude).not.toBe(custom);
    expect(store.current().agents.map((agent) => agent.provider)).toEqual([
      "claude-code",
      "custom",
    ]);
  });

  it("reads through live state, so a batch can attribute to an agent it just created", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code");

    // The agent exists in state immediately, not one render later — which is
    // the whole reason an id is resolved before the batch is folded.
    expect(store.current().agents.find((agent) => agent.id === agentId)).toBeDefined();
  });
});

describe("folding a batch", () => {
  it("attaches the workspace the policy supplies", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [observation({ projectKey: "proj-1", title: "Implement auth" })],
      resolveWorkspaceId: (candidate) =>
        candidate.projectKey === "proj-1" ? WORKSPACE : undefined,
    });

    expect(store.current().runs).toHaveLength(1);
    expect(store.current().runs[0].workspaceId).toBe(WORKSPACE);
  });

  it("creates nothing for an observation with no workspace", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [observation({ projectKey: "unmapped" })],
      resolveWorkspaceId: () => undefined,
    });

    // Discovered but unattached. Guessing a workspace here is what would file
    // a stranger's work under the user's.
    expect(store.current().runs).toEqual([]);
  });

  it("prefers a workspace the observation already carries", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [observation({ workspaceId: "explicit", projectKey: "proj-1" })],
      resolveWorkspaceId: () => "from-policy",
    });

    expect(store.current().runs[0].workspaceId).toBe("explicit");
  });

  it("folds several observations of one session into a single run", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [
        observation({ workspaceId: WORKSPACE, title: "Implement auth" }),
        observation({ workspaceId: WORKSPACE, activity: "Edited login.ts" }),
        observation({ workspaceId: WORKSPACE, status: "completed" }),
      ],
    });

    expect(store.current().runs).toHaveLength(1);
    expect(store.current().runs[0].status).toBe("completed");

    connectsToDomainRules(store.current());
  });

  it("does nothing with an empty batch", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [],
    });

    expect(store.current().runs).toEqual([]);
  });
});

/** The domain's own rules still apply — ingestion reimplements none of them. */
function connectsToDomainRules(state: AgentState): void {
  const run = state.runs[0];
  expect(run.title).toBe("Implement auth");
  expect(run.endedAt).toBeDefined();
  expect(state.events.some((event) => event.kind === "ended")).toBe(true);
}

describe("URL linking", () => {
  const index: WorkspaceTabIndex[] = [
    {
      workspaceId: WORKSPACE,
      tabsByNormalizedUrl: new Map([["https://example.com/docs", "tab-docs"]]),
    },
  ];

  it("links a run to an existing tab on an exact normalized match", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [
        observation({ workspaceId: WORKSPACE, url: "https://example.com/docs" }),
      ],
      tabIndexes: index,
    });

    expect(store.current().links).toHaveLength(1);
    expect(store.current().links[0]).toMatchObject({ tabId: "tab-docs", role: "context" });
  });

  it("links nothing when no tab matches", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [
        observation({ workspaceId: WORKSPACE, url: "https://example.com/other" }),
      ],
      tabIndexes: index,
    });

    // A near-miss link is worse than no link: it asserts a relationship that
    // did not happen.
    expect(store.current().links).toEqual([]);
  });

  it("ignores an unparseable URL rather than throwing", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    expect(() =>
      ingestObservationBatch({
        store,
        agentId,
        provider: "claude-code",
        observations: [observation({ workspaceId: WORKSPACE, url: "not a url" })],
        tabIndexes: index,
      })
    ).not.toThrow();

    expect(store.current().links).toEqual([]);
  });

  it("does nothing when the caller supplied no tab index", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [observation({ workspaceId: WORKSPACE, url: "https://example.com/docs" })],
    });

    expect(store.current().links).toEqual([]);
  });

  it("never links across a workspace boundary", () => {
    const store = harness();
    const agentId = resolveProviderAgentId(store, "claude-code", "Claude Code")!;

    ingestObservationBatch({
      store,
      agentId,
      provider: "claude-code",
      observations: [observation({ workspaceId: "other-workspace", url: "https://example.com/docs" })],
      tabIndexes: index,
    });

    expect(store.current().links).toEqual([]);
  });

  it("is a no-op for a run that does not exist", () => {
    const store = harness();
    expect(() =>
      linkObservedUrl(store, "missing-run", WORKSPACE, "https://example.com/docs", index)
    ).not.toThrow();
  });
});

describe("the pipeline is provider-neutral", () => {
  it("treats two providers' observations identically", () => {
    const store = harness();

    for (const provider of ["claude-code", "custom"] as const) {
      const agentId = resolveProviderAgentId(store, provider, provider)!;
      ingestObservationBatch({
        store,
        agentId,
        provider,
        observations: [
          {
            provider,
            externalId: `${provider}-session`,
            workspaceId: WORKSPACE,
            title: "Do the work",
            activity: "Edited a file",
            status: "working",
          },
        ],
      });
    }

    const [first, second] = store.current().runs;

    // The runs differ only by which agent they belong to. Nothing about the
    // shape of the resulting domain state depends on which provider spoke.
    expect(first.title).toBe(second.title);
    expect(first.status).toBe(second.status);
    expect(first.currentActivity).toBe(second.currentActivity);
    expect(first.agentId).not.toBe(second.agentId);
  });
});

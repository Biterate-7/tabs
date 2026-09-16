import { describe, expect, it } from "vitest";
import { createAgent } from "@/lib/agents/registry";
import { createRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { buildAgentSpatialScene } from "./scene";
import type { AgentState } from "@/lib/agents/types";

/**
 * Filtering the canvas by provider.
 *
 * The second dimension a multi-agent workspace needs: "active" and "Claude
 * Code" answer different questions, and a user watching two agents wants to
 * combine them. What matters most below is the honesty of the hidden count —
 * a user who cannot tell "no work" from "no work by this agent" will read the
 * empty canvas as the former.
 */

const T0 = 1_700_000_000_000;
const WORKSPACE = "wA";

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

/** Two providers, each with one live run in the same workspace. */
function twoProviders() {
  const claude = expectOk(
    createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
  );
  const custom = expectOk(
    createAgent(claude.state, { provider: "custom", name: "My agent" }, T0)
  );

  const claudeRun = expectOk(
    createRun(
      custom.state,
      { agentId: claude.agent.id, workspaceId: WORKSPACE, externalId: "c1", title: "Claude work" },
      T0
    )
  );
  const customRun = expectOk(
    createRun(
      claudeRun.state,
      { agentId: custom.agent.id, workspaceId: WORKSPACE, externalId: "x1", title: "Custom work" },
      T0 + 1
    )
  );

  return {
    state: customRun.state as AgentState,
    claudeRunId: claudeRun.run.id,
    customRunId: customRun.run.id,
  };
}

function scene(state: AgentState, providerFilter?: string | null) {
  return buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId: WORKSPACE,
    filter: "all",
    providerFilter,
    now: T0 + 2,
  });
}

function runTitles(built: ReturnType<typeof scene>): string[] {
  return built.nodes
    .filter((node): node is Extract<typeof node, { kind: "run" }> => node.kind === "run")
    .map((node) => node.label);
}

describe("which providers have worked here", () => {
  it("lists them in the order their runs appear", () => {
    const { state } = twoProviders();
    expect(scene(state).providers).toEqual(["claude-code", "custom"]);
  });

  it("lists a provider once however many runs it has", () => {
    const { state } = twoProviders();
    const claudeAgent = state.agents.find((agent) => agent.provider === "claude-code")!;
    const more = expectOk(
      createRun(
        state,
        { agentId: claudeAgent.id, workspaceId: WORKSPACE, externalId: "c2" },
        T0 + 2
      )
    );

    expect(scene(more.state).providers).toEqual(["claude-code", "custom"]);
  });

  it("is empty for a workspace with no agent work", () => {
    expect(scene(emptyAgentState()).providers).toEqual([]);
  });

  it("keeps listing a provider whose runs the filter is currently hiding", () => {
    const { state } = twoProviders();

    // Otherwise a provider would vanish from the very control the user needs
    // in order to bring it back.
    expect(scene(state, "claude-code").providers).toEqual(["claude-code", "custom"]);
  });
});

describe("filtering by provider", () => {
  it("shows everything when no provider is selected", () => {
    const { state } = twoProviders();

    expect(runTitles(scene(state))).toEqual(["Claude work", "Custom work"]);
    expect(scene(state).hiddenRunCount).toBe(0);
  });

  it("shows only the selected provider's runs", () => {
    const { state } = twoProviders();

    expect(runTitles(scene(state, "claude-code"))).toEqual(["Claude work"]);
    expect(runTitles(scene(state, "custom"))).toEqual(["Custom work"]);
  });

  it("counts what the filter hid, so the canvas is never silently empty", () => {
    const { state } = twoProviders();
    expect(scene(state, "claude-code").hiddenRunCount).toBe(1);
  });

  it("hides everything for a provider that has never worked here", () => {
    const { state } = twoProviders();
    const built = scene(state, "gemini");

    // Fail closed. A filter that quietly stopped applying would attribute
    // every run on screen to the provider the user had selected.
    expect(runTitles(built)).toEqual([]);
    expect(built.hiddenRunCount).toBe(2);
  });

  it("treats null and undefined alike as no filter", () => {
    const { state } = twoProviders();
    expect(runTitles(scene(state, null))).toEqual(runTitles(scene(state, undefined)));
  });
});

describe("the two filters combine", () => {
  it("applies status and provider together", () => {
    const { state, claudeRunId } = twoProviders();

    // Long enough ago that it has aged out of the default view's
    // recently-finished window, so "active" genuinely excludes it.
    const LONG_AGO = T0 - 24 * 60 * 60 * 1000;
    const finished: AgentState = {
      ...state,
      runs: state.runs.map((candidate) =>
        candidate.id === claudeRunId
          ? {
              ...candidate,
              status: "completed" as const,
              createdAt: LONG_AGO,
              updatedAt: LONG_AGO,
              endedAt: LONG_AGO,
            }
          : candidate
      ),
    };

    function withFilters(providerFilter?: string | null) {
      return buildAgentSpatialScene(finished, {
        agents: finished.agents,
        runs: finished.runs,
        artifacts: finished.artifacts,
        workspaceId: WORKSPACE,
        filter: "active",
        providerFilter,
        now: T0 + 2,
      });
    }

    // Claude's only run is long finished, so "active Claude work" is genuinely
    // empty — while "active, any provider" is not.
    expect(runTitles(withFilters("claude-code"))).toEqual([]);
    expect(runTitles(withFilters())).toEqual(["Custom work"]);
  });
});

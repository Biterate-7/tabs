import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { createWorkItem } from "@/lib/agents/work-items";
import { emptyAgentState } from "@/lib/agents/types";
import { EMPTY_PROVIDER_USAGE, summarizeProviderUsage } from "./usage";
import type { AgentState } from "@/lib/agents/types";

const T0 = 1_700_000_000_000;
const PROJECT = "C:/projects/tabdump";

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

/** A domain with one provider that has done a measurable amount of work. */
function populated() {
  const agent = expectOk(
    createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
  );

  const live = expectOk(
    createRun(
      agent.state,
      { agentId: agent.agent.id, workspaceId: "wA", externalId: "s1", title: "Live" },
      T0
    )
  );

  const finished = expectOk(
    createRun(
      live.state,
      { agentId: agent.agent.id, workspaceId: "wB", externalId: "s2", title: "Done" },
      T0 + 1
    )
  );

  let state: AgentState = expectOk(
    transitionRunStatus(finished.state, finished.run.id, "completed", T0 + 2)
  ).state;

  // One file edited twice by one run, plus a second file — so a test can tell
  // "distinct files" from "number of interactions".
  state = expectOk(
    recordArtifactWork(
      state,
      { runId: live.run.id, projectPath: PROJECT, path: "src/auth.ts", role: "edited" },
      T0 + 3
    )
  ).state;
  state = expectOk(
    recordArtifactWork(
      state,
      { runId: live.run.id, projectPath: PROJECT, path: "src/auth.ts", role: "inspected" },
      T0 + 4
    )
  ).state;
  state = expectOk(
    recordArtifactWork(
      state,
      { runId: live.run.id, projectPath: PROJECT, path: "src/login.ts", role: "edited" },
      T0 + 5
    )
  ).state;

  state = expectOk(
    createWorkItem(state, { runId: live.run.id, title: "Implement auth" }, T0 + 6)
  ).state;

  return { state, agentId: agent.agent.id, liveRunId: live.run.id };
}

describe("counting a provider's work", () => {
  it("reports nothing for a provider with no agent", () => {
    expect(summarizeProviderUsage(emptyAgentState(), "gemini")).toEqual(EMPTY_PROVIDER_USAGE);
  });

  it("reports an agent with no runs as an agent, not as work", () => {
    const agent = expectOk(
      createAgent(emptyAgentState(), { provider: "gemini", name: "Gemini" }, T0)
    );

    expect(summarizeProviderUsage(agent.state, "gemini")).toEqual({
      ...EMPTY_PROVIDER_USAGE,
      agents: 1,
    });
  });

  it("separates live runs from finished ones", () => {
    const { state } = populated();
    const usage = summarizeProviderUsage(state, "claude-code");

    expect(usage.activeRuns).toBe(1);
    expect(usage.completedRuns).toBe(1);
    expect(usage.totalRuns).toBe(2);
  });

  it("counts distinct files, not interactions with them", () => {
    const { state } = populated();

    // Counting links would inflate the number until it read as a measure of
    // activity rather than of work product.
    expect(summarizeProviderUsage(state, "claude-code").artifacts).toBe(2);
  });

  it("counts work items across the provider's runs", () => {
    const { state } = populated();
    expect(summarizeProviderUsage(state, "claude-code").workItems).toBe(1);
  });

  it("spans every workspace the provider has worked in", () => {
    const { state } = populated();
    // The question a connector raises is "what has this agent done for me",
    // not "in this one workspace" — the workspace-scoped selectors answer
    // that, and are untouched.
    expect(summarizeProviderUsage(state, "claude-code").totalRuns).toBe(2);
  });

  it("reports the newest run activity", () => {
    const { state } = populated();
    const usage = summarizeProviderUsage(state, "claude-code");

    expect(usage.lastActivityAt).toBeGreaterThanOrEqual(T0);
  });

  it("attributes nothing to a provider that did not do it", () => {
    const { state } = populated();
    expect(summarizeProviderUsage(state, "custom")).toEqual(EMPTY_PROVIDER_USAGE);
  });
});

describe("purity", () => {
  it("does not mutate the state it reads", () => {
    const { state } = populated();
    const before = JSON.stringify(state);

    summarizeProviderUsage(state, "claude-code");

    expect(JSON.stringify(state)).toBe(before);
  });
});

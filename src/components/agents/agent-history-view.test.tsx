import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildAgentHistory } from "@/lib/agents/history/build";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import {
  T0,
  withAgent,
  withArtifact,
  withEvent,
  withRun,
  withTabLink,
  withWorkItem,
} from "@/lib/agents/intelligence/__fixtures__/domain";
import { createAgent } from "@/lib/agents/registry";
import { transitionRunStatus } from "@/lib/agents/runs";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { buildWorldScene } from "@/lib/agents/world/scene";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "@/lib/agents/world/settings";
import { AgentHistoryScreen } from "./agent-history-view";
import type { AgentHistoryFilter } from "@/lib/agents/history/types";
import type { AgentState } from "@/lib/agents/types";

/**
 * Agent History, as a screen.
 *
 * The suite's first job is the phase's defining claim: an old run that the
 * spatial world will not draw is an ordinary, openable row here. That is
 * asserted against the *real* scene builder rather than against an
 * assumption about what the world does.
 */

const LONG_AGO = T0 - RECENT_RUN_WINDOW_MS * 4;
const NOW = T0 + 60_000;

const NAMES = new Map([
  ["dev", "Development"],
  ["ops", "Operations"],
]);

/** One long-finished run, one live run, one custom-agent run with no title. */
function fixture() {
  const base = withAgent("Claude Code", "claude-code");
  const custom = createAgent(base.state, { provider: "custom:acme", name: "Acme Agent" }, T0);
  if (!custom.ok) throw new Error("fixture: custom agent");

  const old = withRun(
    custom.state,
    { agentId: base.agentId, workspaceId: "dev", title: "Fix parser import handling" },
    LONG_AGO
  );
  const item = withWorkItem(
    old.state,
    { runId: old.runId, title: "Rewrite the resolver", status: "completed" },
    LONG_AGO
  );
  let state: AgentState = withTabLink(
    item.state,
    { runId: old.runId, tabId: "t1", role: "context" },
    LONG_AGO
  );
  state = withTabLink(state, { runId: old.runId, tabId: "t2", role: "produced" }, LONG_AGO);
  const filed = withArtifact(
    state,
    { runId: old.runId, path: "src/parser.ts", role: "edited" },
    LONG_AGO
  );
  state = withEvent(filed.state, { runId: old.runId, summary: "Edited parser" }, LONG_AGO);
  const done = transitionRunStatus(state, old.runId, "completed", LONG_AGO + 1000);
  if (!done.ok) throw new Error("fixture: complete");

  const live = withRun(
    done.state,
    { agentId: base.agentId, workspaceId: "dev", status: "working", title: "Read the spec" },
    T0
  );
  const acme = withRun(
    live.state,
    { agentId: custom.agent.id, workspaceId: "ops", status: "waiting" },
    T0
  );

  return {
    state: acme.state,
    index: buildAgentDomainIndex(acme.state),
    oldRunId: old.runId,
    liveRunId: live.runId,
    customRunId: acme.runId,
    customAgentId: custom.agent.id,
  };
}

function renderHistory(filter: AgentHistoryFilter = {}) {
  const f = fixture();
  const onOpenSession = vi.fn();
  const onFilterChange = vi.fn();
  const onClose = vi.fn();

  render(
    <AgentHistoryScreen
      history={buildAgentHistory({ index: f.index, workspaceNames: NAMES, filter })}
      filter={filter}
      onFilterChange={onFilterChange}
      now={NOW}
      onOpenSession={onOpenSession}
      onClose={onClose}
    />
  );

  return { ...f, onOpenSession, onFilterChange, onClose };
}

describe("the durable list", () => {
  it("lists a run the world has stopped drawing, and opens it", async () => {
    const f = renderHistory();

    // The world, asked about the same state, does not have this run.
    const scene = buildWorldScene({
      index: f.index,
      workspaceId: "dev",
      settings: DEFAULT_AGENT_WORLD_SETTINGS,
      now: NOW,
      tabTitles: new Map(),
      idleProviders: [],
    });
    expect(scene.characters.some((character) => character.runId === f.oldRunId)).toBe(false);

    // History does, and it is a working entry point.
    const row = screen.getByRole("button", { name: /Fix parser import handling/ });
    await userEvent.click(row);
    expect(f.onOpenSession).toHaveBeenCalledWith(f.oldRunId);
  });

  it("lists live and finished runs side by side", () => {
    renderHistory();
    expect(screen.getByRole("button", { name: /Read the spec/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Fix parser import handling/ })).toBeTruthy();
  });

  it("gives each row an accessible name carrying who, where and what status", () => {
    renderHistory();
    expect(
      screen.getByRole("button", {
        name: /^Claude Code, Development, Completed, Fix parser import handling/,
      })
    ).toBeTruthy();
  });

  it("states status as a word rather than by colour alone", () => {
    renderHistory();
    expect(screen.getByRole("button", { name: /, Completed, / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /, Working, / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /, Waiting, / })).toBeTruthy();
  });

  it("shows real counts and nothing else", () => {
    renderHistory();
    // One task, one file, two tabs, one event — all recorded, all counted.
    expect(screen.getByText(/1 task · 1 file · 2 tabs · 1 event/)).toBeTruthy();
  });

  it("uses an honest fallback for a run with no recorded description", () => {
    renderHistory();
    expect(screen.getByText("Session with no recorded work description")).toBeTruthy();
  });

  it("lists a custom agent alongside a built-in one", () => {
    renderHistory();
    expect(screen.getByRole("button", { name: /^Acme Agent, Operations, Waiting/ })).toBeTruthy();
  });
});

describe("filtering", () => {
  it("offers agent, workspace and status, and nothing resembling analytics", () => {
    renderHistory();
    expect(screen.getByLabelText("Agent")).toBeTruthy();
    expect(screen.getByLabelText("Workspace")).toBeTruthy();
    expect(screen.getByLabelText("Status")).toBeTruthy();
    // Three controls, not a query builder.
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
  });

  it("reports a chosen status back to its owner", async () => {
    const f = renderHistory();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "completed");
    expect(f.onFilterChange).toHaveBeenCalledWith({ status: "completed" });
  });

  it("narrows the list and says how much of it is showing", () => {
    renderHistory({ status: "completed" });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Fix parser import handling/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Read the spec/ })).toBeNull();
  });

  it("says so when a filter matches nothing, without implying failure", () => {
    renderHistory({ status: "failed" });
    expect(screen.getByText("No sessions match this filter.")).toBeTruthy();
  });

  it("keeps every option available so a filter can be undone", () => {
    const f = renderHistory({ agentId: "nonexistent" });
    const agents = screen.getByLabelText("Agent") as HTMLSelectElement;
    const values = [...agents.options].map((option) => option.value);
    expect(values).toContain(f.customAgentId);
  });
});

describe("empty state", () => {
  it("distinguishes 'nothing recorded' from 'nothing matched'", () => {
    render(
      <AgentHistoryScreen
        history={buildAgentHistory({ index: buildAgentDomainIndex(withAgent().state) })}
        filter={{}}
        onFilterChange={vi.fn()}
        now={NOW}
        onOpenSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("No agent sessions recorded yet")).toBeTruthy();
    // No filters are offered when there is nothing to filter.
    expect(screen.queryByLabelText("Agent")).toBeNull();
  });
});

describe("navigation", () => {
  it("offers a way back", async () => {
    const f = renderHistory();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(f.onClose).toHaveBeenCalled();
  });

  it("is keyboard reachable — every row is a single tab stop", async () => {
    const f = renderHistory();
    const row = screen.getByRole("button", { name: /Fix parser import handling/ });
    row.focus();
    expect(document.activeElement).toBe(row);

    await userEvent.keyboard("{Enter}");
    expect(f.onOpenSession).toHaveBeenCalledWith(f.oldRunId);
  });
});

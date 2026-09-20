import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import {
  PROJECT,
  T0,
  withAgent,
  withArtifact,
  withEventId,
  withEvidence,
  withRun,
  withTabLink,
  withWorkItem,
} from "@/lib/agents/intelligence/__fixtures__/domain";
import { createAgent } from "@/lib/agents/registry";
import { transitionRunStatus } from "@/lib/agents/runs";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { buildAgentSession } from "@/lib/agents/session/build";
import { AgentSessionScreen } from "./agent-session-view";
import type { AgentSessionView as SessionModel } from "@/lib/agents/session/types";
import type { AgentState } from "@/lib/agents/types";

/**
 * The Session View, as a screen.
 *
 * Every session rendered here is produced by the real `buildAgentSession`
 * over state built by the real domain operations. A hand-written session
 * model could satisfy each assertion below while the builder did something
 * else, which would make the disjointness tests worthless - they are the
 * whole point of the suite.
 *
 * The run under test is deliberately older than the world's recency window,
 * so nothing here can accidentally pass because the run happens to be live.
 */

const LONG_AGO = T0 - RECENT_RUN_WINDOW_MS * 4;
const NOW = T0 + 60_000;

/** Task A: tab-a, src/a.ts, one event. Task B: tab-b, src/b.ts, one event. Task C: nothing. */
function multiTaskRun() {
  const base = withAgent("Claude Code", "claude-code");
  const run = withRun(
    base.state,
    { agentId: base.agentId, workspaceId: "dev", title: "Fix parser import handling" },
    LONG_AGO
  );

  const a = withWorkItem(
    run.state,
    { runId: run.runId, title: "Research inflation", status: "completed" },
    LONG_AGO
  );
  const b = withWorkItem(
    a.state,
    { runId: run.runId, title: "Draft conclusion", status: "completed" },
    LONG_AGO + 1
  );
  const c = withWorkItem(
    b.state,
    { runId: run.runId, title: "Unrecorded task", status: "pending" },
    LONG_AGO + 2
  );

  let state: AgentState = c.state;
  state = withTabLink(state, { runId: run.runId, tabId: "tab-a", role: "context" }, LONG_AGO);
  state = withTabLink(state, { runId: run.runId, tabId: "tab-b", role: "context" }, LONG_AGO);
  state = withTabLink(state, { runId: run.runId, tabId: "tab-gone", role: "context" }, LONG_AGO);

  const fileA = withArtifact(
    state,
    { runId: run.runId, path: "src/parser.ts", role: "edited" },
    LONG_AGO
  );
  const fileB = withArtifact(
    fileA.state,
    { runId: run.runId, path: "src/notes.md", role: "inspected" },
    LONG_AGO
  );
  const eventA = withEventId(fileB.state, { runId: run.runId, summary: "Edited parser" }, LONG_AGO);
  const eventB = withEventId(
    eventA.state,
    { runId: run.runId, summary: "Read the notes" },
    LONG_AGO + 10
  );
  const eventLoose = withEventId(
    eventB.state,
    { runId: run.runId, summary: "Ran the test suite" },
    LONG_AGO + 20
  );
  state = eventLoose.state;

  state = withEvidence(state, { workItemId: a.workItemId, kind: "tab", targetId: "tab-a" });
  state = withEvidence(state, {
    workItemId: a.workItemId,
    kind: "artifact",
    targetId: fileA.artifactId,
  });
  state = withEvidence(state, { workItemId: a.workItemId, kind: "event", targetId: eventA.eventId });

  state = withEvidence(state, { workItemId: b.workItemId, kind: "tab", targetId: "tab-b" });
  state = withEvidence(state, {
    workItemId: b.workItemId,
    kind: "artifact",
    targetId: fileB.artifactId,
  });
  state = withEvidence(state, { workItemId: b.workItemId, kind: "event", targetId: eventB.eventId });

  const done = transitionRunStatus(state, run.runId, "completed", LONG_AGO + 1000);
  if (!done.ok) throw new Error("fixture: complete run");

  const result = buildAgentSession(buildAgentDomainIndex(done.state), run.runId);
  if (!result.ok) throw new Error("fixture: session did not resolve");

  return { session: result.session, state: done.state, runId: run.runId };
}

/** `tab-gone` is absent, so the screen must render it as stale. */
const TAB_TITLES = new Map([
  ["tab-a", "Inflation data 2024"],
  ["tab-b", "Draft document"],
]);

function renderSession(
  session: SessionModel,
  over: Partial<React.ComponentProps<typeof AgentSessionScreen>> = {}
) {
  const onSelectWorkItem = vi.fn();
  const onOpenTab = vi.fn();
  const onOpenWorld = vi.fn();
  const onClose = vi.fn();

  const props = {
    session,
    workspaceName: "Development",
    tabTitles: TAB_TITLES,
    now: NOW,
    selectedWorkItemId: null,
    onSelectWorkItem,
    onOpenTab,
    onOpenWorld,
    onClose,
    ...over,
  };

  const utils = render(<AgentSessionScreen {...props} />);
  return { ...utils, onSelectWorkItem, onOpenTab, onOpenWorld, onClose };
}

/**
 * The two landmarks the separation invariant is expressed in.
 *
 * Every disjointness assertion below is scoped to one of them. Counting
 * occurrences across the whole screen would be ambiguous: a produced file
 * legitimately appears under both FILES and RESULT within the same section.
 */
function regions() {
  // Lazy, because the task-evidence landmark exists only while a task is
  // selected — the run-level one is always present.
  return {
    get taskEvidence() {
      return screen.getByRole("region", { name: "Evidence recorded for this task" });
    },
    get runContext() {
      return screen.getByRole("region", { name: "The run around this work" });
    },
  };
}

describe("the session header", () => {
  it("names who, where, what status and what work", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    expect(screen.getByRole("heading", { level: 1, name: "Claude Code" })).toBeTruthy();
    // Workspace, run status and start time share the header's second line.
    expect(screen.getByText(/^Development . Completed . started/)).toBeTruthy();
    expect(screen.getByText("Fix parser import handling")).toBeTruthy();
  });

  it("renders an old run in full, with no dependence on recency", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    // Every task is on screen, though the run left the world's window long
    // ago and is drawn on no canvas.
    expect(screen.getByRole("button", { name: /Research inflation/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Draft conclusion/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unrecorded task/ })).toBeTruthy();
  });

  it("uses an honest fallback for a run with no recorded title", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "dev" }, LONG_AGO);
    const result = buildAgentSession(buildAgentDomainIndex(run.state), run.runId);
    if (!result.ok) throw new Error("unreachable");

    renderSession(result.session);
    expect(screen.getByText("Session with no recorded work description")).toBeTruthy();
  });

  it("says the agent is unknown rather than naming another one", () => {
    const { session, state, runId } = multiTaskRun();
    expect(session.agent).not.toBeNull();

    const orphaned: AgentState = { ...state, agents: [] };
    const result = buildAgentSession(buildAgentDomainIndex(orphaned), runId);
    if (!result.ok) throw new Error("unreachable");

    renderSession(result.session);
    expect(screen.getByRole("heading", { level: 1, name: "Unknown agent" })).toBeTruthy();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });
});

describe("work items", () => {
  it("shows every item with its status and evidence counts", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    expect(
      screen.getByRole("button", { name: "Research inflation, Completed, 1 file · 1 tab · 1 event" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Unrecorded task, Pending, No recorded evidence" })
    ).toBeTruthy();
  });

  it("states status as a word, not as colour alone", () => {
    const { session } = multiTaskRun();
    renderSession(session);
    // Two completed tasks and one pending, each spelled out in its row's
    // accessible name.
    expect(screen.getAllByRole("button", { name: /, Completed, / })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /, Pending, / })).toHaveLength(1);
  });

  it("marks the selected item as pressed", async () => {
    const { session } = multiTaskRun();
    const itemA = session.workItems[0]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemA });

    const selected = screen.getByRole("button", { name: /Research inflation/ });
    expect(selected.getAttribute("aria-pressed")).toBe("true");

    const other = screen.getByRole("button", { name: /Draft conclusion/ });
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports a selection back to its owner", async () => {
    const { session } = multiTaskRun();
    const { onSelectWorkItem } = renderSession(session);

    await userEvent.click(screen.getByRole("button", { name: /Draft conclusion/ }));
    expect(onSelectWorkItem).toHaveBeenCalledWith(session.workItems[1]!.reference.workItemId);
  });
});

describe("task evidence stays separate from run context", () => {
  it("shows only Task A's evidence when Task A is selected", () => {
    const { session } = multiTaskRun();
    const itemA = session.workItems[0]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemA });

    const { taskEvidence, runContext } = regions();

    // Task A's file is its evidence; Task B's is not, though both belong to
    // the run and both appear in the run's own list below.
    expect(within(taskEvidence).getAllByText("src/parser.ts").length).toBeGreaterThan(0);
    expect(within(taskEvidence).queryByText("src/notes.md")).toBeNull();
    expect(within(runContext).getByText("src/notes.md")).toBeTruthy();
  });

  it("shows different evidence for Task B", () => {
    const { session } = multiTaskRun();
    const itemB = session.workItems[1]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemB });

    const { taskEvidence } = regions();
    expect(within(taskEvidence).getAllByText("src/notes.md").length).toBeGreaterThan(0);
    expect(within(taskEvidence).queryByText("src/parser.ts")).toBeNull();
  });

  it("never puts a run-level-only tab under a selected task", () => {
    const { session } = multiTaskRun();
    const itemA = session.workItems[0]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemA });

    const { taskEvidence, runContext } = regions();
    // "Draft document" is tab-b: on the run, evidence for Task B only.
    expect(within(runContext).getByRole("button", { name: "Open tab Draft document" })).toBeTruthy();
    expect(
      within(taskEvidence).queryByRole("button", { name: "Open tab Draft document" })
    ).toBeNull();
  });

  it("labels the run section as run-level rather than task evidence", () => {
    const { session } = multiTaskRun();
    renderSession(session);
    expect(
      screen.getByText(/are not necessarily evidence for the selected task/i)
    ).toBeTruthy();
  });

  it("says so honestly when a task has no recorded evidence", () => {
    const { session } = multiTaskRun();
    const itemC = session.workItems[2]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemC });

    expect(screen.getByText("No recorded evidence for this task.")).toBeTruthy();
  });
});

describe("the timeline", () => {
  it("keeps unrelated run events while highlighting the task's own", () => {
    const { session } = multiTaskRun();
    const itemA = session.workItems[0]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemA });

    const { runContext } = regions();
    // The unrelated event is still there — the task's evidence is shown
    // *within* the run's activity, not instead of it.
    expect(within(runContext).getByText("Ran the test suite")).toBeTruthy();
    // And the highlight is carried by a word, not only by colour.
    expect(within(runContext).getAllByText("This task").length).toBe(1);
  });

  it("highlights nothing when no task is selected", () => {
    const { session } = multiTaskRun();
    renderSession(session);
    expect(screen.queryByText("This task")).toBeNull();
  });
});

describe("tabs and files", () => {
  it("opens a tab through the app's existing mechanism", async () => {
    const { session } = multiTaskRun();
    const { onOpenTab } = renderSession(session);

    await userEvent.click(
      within(regions().runContext).getByRole("button", { name: "Open tab Inflation data 2024" })
    );
    expect(onOpenTab).toHaveBeenCalledWith("tab-a");
  });

  it("shows a deleted tab as stale rather than fabricating a replacement", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    expect(screen.getByText("This tab is no longer saved in TabDump")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open tab tab-gone/ })).toBeNull();
  });

  it("offers no way to open a file", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent).not.toContain("src/parser.ts");
      expect(button.getAttribute("aria-label") ?? "").not.toContain("src/parser.ts");
    }
  });

  it("never renders an absolute project path or an artifact id", () => {
    const { session } = multiTaskRun();
    const { container } = renderSession(session);

    expect(container.innerHTML).not.toContain(PROJECT);
    expect(container.innerHTML).not.toContain("wa-");
  });
});

describe("results", () => {
  it("counts an edited file as a result and a read one as not", () => {
    const { session } = multiTaskRun();
    const itemB = session.workItems[1]!.reference.workItemId;
    renderSession(session, { selectedWorkItemId: itemB });

    // Task B only read its file, so it has no result.
    expect(screen.getByText("No recorded result for this task.")).toBeTruthy();
  });

  it("shows the run's produced file as its result", () => {
    const { session } = multiTaskRun();
    renderSession(session);

    const result = within(regions().runContext).getByRole("region", { name: "RESULT" });
    expect(within(result).getByText("src/parser.ts")).toBeTruthy();
    // A file the run only read is not a result.
    expect(within(result).queryByText("src/notes.md")).toBeNull();
  });

  it("says a run with nothing produced has no result", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "dev" }, LONG_AGO);
    const result = buildAgentSession(buildAgentDomainIndex(run.state), run.runId);
    if (!result.ok) throw new Error("unreachable");

    renderSession(result.session);
    expect(screen.getByText("No recorded result.")).toBeTruthy();
  });
});

describe("empty states", () => {
  it("says a run has no work items, no tabs, no events", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "dev" }, LONG_AGO);
    const result = buildAgentSession(buildAgentDomainIndex(run.state), run.runId);
    if (!result.ok) throw new Error("unreachable");

    renderSession(result.session);
    expect(screen.getByText("No recorded work items.")).toBeTruthy();
    expect(screen.getByText("No saved TabDump tabs are linked to this session.")).toBeTruthy();
    expect(screen.getByText("No recorded events for this session.")).toBeTruthy();
  });
});

describe("navigation", () => {
  it("offers a way back to the Agent World", async () => {
    const { session } = multiTaskRun();
    const { onOpenWorld } = renderSession(session);

    await userEvent.click(screen.getByRole("button", { name: "Open Agent World" }));
    expect(onOpenWorld).toHaveBeenCalled();
  });

  it("offers a way back out", async () => {
    const { session } = multiTaskRun();
    const { onClose } = renderSession(session);

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("omits the copy control when no address was supplied", () => {
    const { session } = multiTaskRun();
    renderSession(session, { onCopyLink: undefined });
    expect(screen.queryByRole("button", { name: "Copy link to this session" })).toBeNull();
  });
});

describe("custom agents", () => {
  it("render identically, with no provider branching", () => {
    const base = withAgent();
    const custom = createAgent(base.state, { provider: "custom:acme", name: "Acme Agent" }, T0);
    if (!custom.ok) throw new Error("fixture: custom agent");

    const run = withRun(
      custom.state,
      { agentId: custom.agent.id, workspaceId: "ops", title: "Rotate the keys" },
      LONG_AGO
    );
    const item = withWorkItem(run.state, { runId: run.runId, title: "Check expiry" }, LONG_AGO);
    let state = withTabLink(
      item.state,
      { runId: run.runId, tabId: "tab-a", role: "context" },
      LONG_AGO
    );
    const file = withArtifact(
      state,
      { runId: run.runId, path: "ops/keys.md", role: "edited" },
      LONG_AGO
    );
    state = file.state;
    state = withEvidence(state, { workItemId: item.workItemId, kind: "tab", targetId: "tab-a" });
    state = withEvidence(state, {
      workItemId: item.workItemId,
      kind: "artifact",
      targetId: file.artifactId,
    });

    const result = buildAgentSession(buildAgentDomainIndex(state), run.runId);
    if (!result.ok) throw new Error("unreachable");

    renderSession(result.session, {
      selectedWorkItemId: item.workItemId,
      workspaceName: "Operations",
    });

    const { taskEvidence, runContext } = regions();
    expect(screen.getByRole("heading", { level: 1, name: "Acme Agent" })).toBeTruthy();
    expect(screen.getByText("Rotate the keys")).toBeTruthy();
    // The full surface works for a custom provider: task evidence, run
    // context, files and tabs all resolve exactly as for a built-in agent.
    expect(within(taskEvidence).getAllByText("ops/keys.md").length).toBeGreaterThan(0);
    expect(within(runContext).getAllByText("ops/keys.md").length).toBeGreaterThan(0);
    expect(
      within(taskEvidence).getByRole("button", { name: "Open tab Inflation data 2024" })
    ).toBeTruthy();
  });
});

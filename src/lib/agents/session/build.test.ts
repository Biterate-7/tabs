import { describe, expect, it } from "vitest";
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
import { buildAgentSession } from "./build";
import type { AgentState } from "@/lib/agents/types";

/**
 * The Session View's read model.
 *
 * The suite is built around the multi-task run the brief specifies — Task A
 * with one tab, one file and one event; Task B with a different tab, file
 * and event; Task C with nothing at all — because that is the shape in
 * which an evidence leak would be visible. Several tests assert that a
 * task's evidence is *not* its run's, which is the single invariant the
 * whole surface rests on.
 */

/** Older than the world's window, so no test here can accidentally depend on recency. */
const LONG_AGO = T0 - RECENT_RUN_WINDOW_MS * 4;

function session() {
  const base = withAgent("Claude Code", "claude-code");
  const run = withRun(
    base.state,
    {
      agentId: base.agentId,
      workspaceId: "dev",
      status: "working",
      title: "Fix parser import handling",
    },
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

  // Run-level relationships: two tabs, two files, two events, plus one
  // extra tab that belongs to no task at all.
  let state: AgentState = c.state;
  state = withTabLink(state, { runId: run.runId, tabId: "tab-a", role: "context" }, LONG_AGO);
  state = withTabLink(state, { runId: run.runId, tabId: "tab-b", role: "context" }, LONG_AGO);
  state = withTabLink(state, { runId: run.runId, tabId: "tab-loose", role: "produced" }, LONG_AGO);

  const fileA = withArtifact(
    state,
    { runId: run.runId, path: "src/a.ts", role: "edited" },
    LONG_AGO
  );
  const fileB = withArtifact(
    fileA.state,
    { runId: run.runId, path: "src/b.ts", role: "inspected" },
    LONG_AGO
  );
  state = fileB.state;

  const eventA = withEventId(state, { runId: run.runId, summary: "Edited a.ts" }, LONG_AGO);
  const eventB = withEventId(
    eventA.state,
    { runId: run.runId, summary: "Read b.ts" },
    LONG_AGO + 10
  );
  const eventLoose = withEventId(
    eventB.state,
    { runId: run.runId, summary: "Ran the test suite" },
    LONG_AGO + 20
  );
  state = eventLoose.state;

  // Explicit attribution. Task C is given none, on purpose.
  state = withEvidence(state, { workItemId: a.workItemId, kind: "tab", targetId: "tab-a" });
  state = withEvidence(state, {
    workItemId: a.workItemId,
    kind: "artifact",
    targetId: fileA.artifactId,
  });
  state = withEvidence(state, {
    workItemId: a.workItemId,
    kind: "event",
    targetId: eventA.eventId,
  });

  state = withEvidence(state, { workItemId: b.workItemId, kind: "tab", targetId: "tab-b" });
  state = withEvidence(state, {
    workItemId: b.workItemId,
    kind: "artifact",
    targetId: fileB.artifactId,
  });
  state = withEvidence(state, {
    workItemId: b.workItemId,
    kind: "event",
    targetId: eventB.eventId,
  });

  const finished = transitionRunStatus(state, run.runId, "completed", LONG_AGO + 1000);
  if (!finished.ok) throw new Error("fixture: complete run");

  return {
    state: finished.state,
    index: buildAgentDomainIndex(finished.state),
    runId: run.runId,
    agentId: base.agentId,
    itemA: a.workItemId,
    itemB: b.workItemId,
    itemC: c.workItemId,
    fileA: fileA.artifactId,
    fileB: fileB.artifactId,
    eventA: eventA.eventId,
    eventB: eventB.eventId,
    eventLoose: eventLoose.eventId,
  };
}

function open(s: ReturnType<typeof session>) {
  const result = buildAgentSession(s.index, s.runId);
  if (!result.ok) throw new Error(`session did not resolve: ${result.reason}`);
  return result.session;
}

describe("buildAgentSession", () => {
  it("resolves a run that is far outside the world's recency window", () => {
    const s = session();
    const view = open(s);

    expect(view.runId).toBe(s.runId);
    expect(view.status).toBe("completed");
    expect(view.title).toBe("Fix parser import handling");
    expect(view.workspaceId).toBe("dev");
    expect(view.agent?.name).toBe("Claude Code");
    // Every work item is present, completed ones included.
    expect(view.workItems).toHaveLength(3);
  });

  it("refuses an unknown run rather than resolving a nearby one", () => {
    const s = session();
    expect(buildAgentSession(s.index, "no-such-run")).toEqual({
      ok: false,
      reason: "run-not-found",
    });
  });

  it("uses no clock — the same state builds the same session", () => {
    const s = session();
    expect(buildAgentSession(s.index, s.runId)).toEqual(buildAgentSession(s.index, s.runId));
  });
});

describe("task evidence", () => {
  it("gives each task exactly what was recorded for it", () => {
    const s = session();
    const view = open(s);
    const [a, b, c] = view.workItems;

    expect(a?.evidence.tabIds).toEqual(["tab-a"]);
    expect(a?.evidence.artifacts.map((file) => file.relativePath)).toEqual(["src/a.ts"]);
    expect(a?.evidence.events.map((event) => event.summary)).toEqual(["Edited a.ts"]);
    expect(a?.evidence.total).toBe(3);

    expect(b?.evidence.tabIds).toEqual(["tab-b"]);
    expect(b?.evidence.artifacts.map((file) => file.relativePath)).toEqual(["src/b.ts"]);
    expect(b?.evidence.events.map((event) => event.summary)).toEqual(["Read b.ts"]);

    // Task C: nothing recorded, and nothing derived to fill the gap.
    expect(c?.evidence.total).toBe(0);
    expect(c?.evidence.tabIds).toEqual([]);
    expect(c?.evidence.artifacts).toEqual([]);
    expect(c?.evidence.events).toEqual([]);
  });

  it("keeps two tasks' evidence disjoint", () => {
    const s = session();
    const view = open(s);
    const [a, b] = view.workItems;

    const aTabs = new Set(a?.evidence.tabIds);
    const bTabs = new Set(b?.evidence.tabIds);
    for (const tab of bTabs) expect(aTabs.has(tab)).toBe(false);

    const aFiles = new Set(a?.evidence.artifacts.map((file) => file.key));
    for (const file of b?.evidence.artifacts ?? []) {
      expect(aFiles.has(file.key)).toBe(false);
    }
  });

  it("never shows a run-level tab under a task", () => {
    const s = session();
    const view = open(s);

    // `tab-loose` is on the run and attributed to nothing.
    expect(view.runContext.producedTabIds).toContain("tab-loose");
    for (const item of view.workItems) {
      expect(item.evidence.tabIds).not.toContain("tab-loose");
    }
  });

  it("carries the run's own role onto an evidenced file, without inventing one", () => {
    const s = session();
    const view = open(s);

    expect(view.workItems[0]?.evidence.artifacts[0]?.roles).toEqual(["edited"]);
    // Inspected stays inspected. A read file is not a result.
    expect(view.workItems[1]?.evidence.artifacts[0]?.roles).toEqual(["inspected"]);
  });
});

describe("run-level context", () => {
  it("is the run's own relationships, not the union of its tasks'", () => {
    const s = session();
    const view = open(s);

    expect(new Set(view.runContext.contextTabIds)).toEqual(new Set(["tab-a", "tab-b"]));
    expect(view.runContext.producedTabIds).toEqual(["tab-loose"]);
    expect(view.runContext.artifacts).toHaveLength(2);
  });

  it("keeps the whole timeline, including events no task claimed", () => {
    const s = session();
    const view = open(s);

    expect(view.runContext.events.map((event) => event.eventId)).toContain(s.eventLoose);
    // Oldest first: a timeline read forwards.
    const stamps = view.runContext.events.map((event) => event.timestamp);
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps);
  });

  it("never exposes an event's provider source id", () => {
    const s = session();
    const view = open(s);
    for (const event of view.runContext.events) {
      expect(Object.keys(event).sort()).toEqual(["eventId", "kind", "summary", "timestamp"]);
    }
  });

  it("never exposes a file's absolute project path", () => {
    const s = session();
    const view = open(s);

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(PROJECT);
    // No artifact id anywhere in the model, because an artifact id *is* a
    // project path with a prefix. Files carry an opaque session key instead.
    expect(serialised).not.toContain("artifactId");
    expect(serialised).not.toContain("wa-");
    for (const file of view.runContext.artifacts) {
      expect(Object.keys(file).sort()).toEqual(["key", "relativePath", "roles", "updatedAt"]);
    }
  });

  it("never exposes a run's or a work item's provider external id", () => {
    const s = session();
    const view = open(s);
    expect(JSON.stringify(view)).not.toContain("externalId");
  });
});

describe("degraded and empty records", () => {
  it("reports a run with no work items honestly", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "dev" }, LONG_AGO);
    const result = buildAgentSession(buildAgentDomainIndex(run.state), run.runId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.workItems).toEqual([]);
    expect(result.session.runContext.contextTabIds).toEqual([]);
    expect(result.session.runContext.artifacts).toEqual([]);
    expect(result.session.runContext.events).toEqual([]);
  });

  it("reports a run with no title as having none, rather than composing one", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "dev" }, LONG_AGO);
    const result = buildAgentSession(buildAgentDomainIndex(run.state), run.runId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.title).toBeUndefined();
  });

  it("reports a missing agent as null and substitutes no other", () => {
    const s = session();
    // Constructed explicitly — the registry refuses to delete an agent that
    // has runs, so this is the partial-restore case rather than a normal one.
    const orphaned: AgentState = { ...s.state, agents: [] };
    const result = buildAgentSession(buildAgentDomainIndex(orphaned), s.runId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.agent).toBeNull();
  });
});

describe("custom agents take the same path", () => {
  it("resolves a custom-provider run with full evidence", () => {
    const base = withAgent();
    const custom = createAgent(base.state, { provider: "custom:acme", name: "Acme" }, T0);
    if (!custom.ok) throw new Error("fixture: custom agent");

    const run = withRun(
      custom.state,
      { agentId: custom.agent.id, workspaceId: "ops", title: "Rotate the keys" },
      LONG_AGO
    );
    const item = withWorkItem(run.state, { runId: run.runId, title: "Check expiry" }, LONG_AGO);
    let state = withTabLink(
      item.state,
      { runId: run.runId, tabId: "tab-ops", role: "context" },
      LONG_AGO
    );
    const file = withArtifact(
      state,
      { runId: run.runId, path: "ops/keys.md", role: "edited" },
      LONG_AGO
    );
    state = file.state;
    state = withEvidence(state, { workItemId: item.workItemId, kind: "tab", targetId: "tab-ops" });
    state = withEvidence(state, {
      workItemId: item.workItemId,
      kind: "artifact",
      targetId: file.artifactId,
    });

    const result = buildAgentSession(buildAgentDomainIndex(state), run.runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.agent?.provider).toBe("custom:acme");
    expect(result.session.workItems[0]?.evidence.tabIds).toEqual(["tab-ops"]);
    expect(result.session.workItems[0]?.evidence.artifacts).toHaveLength(1);
  });
});

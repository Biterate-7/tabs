import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentState, saveAgentState } from "@/lib/agents/persistence";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { buildAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { getAgentRelationshipsForRun } from "./relationships";
import { getAgentRunSummary } from "./run-summary";
import {
  getActiveAgentRuns,
  getRunsForWorkspace,
  getWorkItemsForWorkspace,
  getWorkspaceRunImpact,
  getWorkspaceRunSummary,
} from "./selectors";
import {
  getAgentActivityCard,
  getWorkspaceActivityCards,
  getWorkspaceAgentActivity,
} from "./workspace-activity";
import {
  T0,
  withAgent,
  withArtifact,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";
import type { AgentState } from "@/lib/agents/types";

/**
 * The boundary tests.
 *
 * Two workspaces built to be as confusable as the domain permits: the **same
 * agent**, the **same tab ids**, the **same file paths**, the **same work
 * item titles**. Everything that could be used as a join key by mistake is
 * identical, so any selector that keys on something other than the workspace
 * will visibly cross over.
 *
 * This is the shape §15 asks for, and the reason it is worth building: a
 * leak caused by matching on a URL or a filename does not look like a bug in
 * a test that gave the two workspaces different data.
 */

/** `w1` and `w2`, deliberately indistinguishable except by workspace. */
function twoWorkspaces() {
  const base = withAgent();

  const runA = withRun(base.state, {
    agentId: base.agentId,
    workspaceId: "w1",
    title: "Session",
  });
  const runB = withRun(runA.state, {
    agentId: base.agentId,
    workspaceId: "w2",
    title: "Session",
  });

  let state = runB.state;

  // Identical work item titles in both.
  state = withWorkItem(state, {
    runId: runA.runId,
    title: "Implement authentication",
    status: "active",
  }).state;
  state = withWorkItem(state, {
    runId: runB.runId,
    title: "Implement authentication",
    status: "active",
  }).state;

  // Identical relative paths, identical project root.
  const fileA = withArtifact(state, {
    runId: runA.runId,
    path: "src/auth.ts",
    role: "edited",
  });
  state = fileA.state;
  const fileB = withArtifact(state, {
    runId: runB.runId,
    path: "src/auth.ts",
    role: "edited",
  });
  state = fileB.state;

  // Identical tab ids. The domain scopes a link by its run's workspace, and
  // `addRunLink` is told the tab's workspace, so each stays put.
  state = withTabLink(state, { runId: runA.runId, tabId: "tab-shared", role: "context" });
  state = withTabLink(state, { runId: runB.runId, tabId: "tab-shared", role: "context" });

  return {
    state,
    agentId: base.agentId,
    runA: runA.runId,
    runB: runB.runId,
    fileA: fileA.artifactId,
    fileB: fileB.artifactId,
  };
}

describe("workspace isolation", () => {
  it("returns only one workspace's runs, though the agent is shared", () => {
    const { state, runA, runB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    expect(getRunsForWorkspace(index, "w1").map((r) => r.runId)).toEqual([runA]);
    expect(getRunsForWorkspace(index, "w2").map((r) => r.runId)).toEqual([runB]);
  });

  it("returns only one workspace's work items, though the titles are identical", () => {
    const { state, runA, runB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    const w1 = getWorkItemsForWorkspace(index, "w1");
    const w2 = getWorkItemsForWorkspace(index, "w2");

    expect(w1).toHaveLength(1);
    expect(w2).toHaveLength(1);
    expect(w1[0].runId).toBe(runA);
    expect(w2[0].runId).toBe(runB);
    // Same text, different item.
    expect(w1[0].title).toBe(w2[0].title);
    expect(w1[0].workItemId).not.toBe(w2[0].workItemId);
  });

  it("gives each workspace its own artifact, though the relative path is identical", () => {
    const { state, runA, runB, fileA, fileB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    const impactA = getAgentRunImpact(index, runA)!;
    const impactB = getAgentRunImpact(index, runB)!;

    expect(impactA.artifacts.map((e) => e.artifact.artifactId)).toEqual([fileA]);
    expect(impactB.artifacts.map((e) => e.artifact.artifactId)).toEqual([fileB]);
    expect(fileA).not.toBe(fileB);
    // Identical display path, different identity — the workspace is in the id.
    expect(impactA.artifacts[0].artifact.relativePath).toBe(
      impactB.artifacts[0].artifact.relativePath
    );
  });

  it("does not let a shared tab id join two workspaces", () => {
    const { state, runA, runB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    // Both reference "tab-shared", but each run reaches it only through its
    // own link. Neither impact grows because the other exists.
    expect(getAgentRunImpact(index, runA)!.affectedTabIds).toEqual(["tab-shared"]);
    expect(getAgentRunImpact(index, runB)!.affectedTabIds).toEqual(["tab-shared"]);
    expect(getAgentRelationshipsForRun(index, runA)).toHaveLength(3);
    expect(getAgentRelationshipsForRun(index, runB)).toHaveLength(3);
  });

  it("scopes workspace activity to one workspace", () => {
    const { state, runA, runB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    const w1 = getWorkspaceAgentActivity(index, "w1");
    expect(w1.activeRuns.map((r) => r.runId)).toEqual([runA]);
    expect(w1.activeWorkItems).toHaveLength(1);
    expect(w1.recentlyTouchedArtifacts).toHaveLength(1);

    const everyRunId = Object.values(w1.byStatus)
      .flat()
      .map((r) => r.runId);
    expect(everyRunId).not.toContain(runB);
  });

  it("refuses to summarise a run from another workspace", () => {
    const { state, runA, runB } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    // The unscoped selector answers for any run it holds...
    expect(getAgentRunSummary(index, runB)).toBeDefined();
    // ...and the workspace-scoped one refuses to cross over.
    expect(getWorkspaceRunSummary(index, "w1", runB)).toBeUndefined();
    expect(getWorkspaceRunSummary(index, "w1", runA)).toBeDefined();
    expect(getWorkspaceRunImpact(index, "w1", runB)).toBeUndefined();
    expect(getAgentActivityCard(index, "w1", runB)).toBeUndefined();
  });

  it("keeps activity cards within the workspace", () => {
    const { state, runA } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    const cards = getWorkspaceActivityCards(index, "w1");
    expect(cards.map((card) => card.runId)).toEqual([runA]);
  });

  it("returns nothing for a workspace that has no agent work", () => {
    const { state } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    expect(getRunsForWorkspace(index, "w3")).toEqual([]);
    expect(getWorkItemsForWorkspace(index, "w3")).toEqual([]);
    expect(getActiveAgentRuns(index, "w3")).toEqual([]);

    const activity = getWorkspaceAgentActivity(index, "w3");
    expect(activity.activeRuns).toEqual([]);
    expect(activity.lastActivityAt).toBeUndefined();
  });

  it("treats an empty workspace id as selecting nothing, never everything", () => {
    const { state } = twoWorkspaces();
    const index = buildAgentDomainIndex(state);

    expect(getRunsForWorkspace(index, "")).toEqual([]);
    expect(getWorkItemsForWorkspace(index, "")).toEqual([]);
    expect(getActiveAgentRuns(index, "")).toEqual([]);
    expect(getWorkspaceActivityCards(index, "")).toEqual([]);
    expect(getWorkspaceAgentActivity(index, "").activeRuns).toEqual([]);
  });

  /**
   * The one case the index must actively defend against.
   *
   * Persistence drops a work item whose `workspaceId` disagrees with its
   * run's, but in-memory state is not a trust boundary either. This builds
   * that impossible state directly and checks the item is omitted rather than
   * re-parented into whichever workspace it claims.
   */
  it("drops a work item that claims a different workspace than its run", () => {
    const { state, runA } = twoWorkspaces();

    const tampered: AgentState = {
      ...state,
      workItems: state.workItems.map((item) =>
        item.runId === runA ? { ...item, workspaceId: "w2" } : item
      ),
    };

    const index = buildAgentDomainIndex(tampered);

    // Not in its claimed workspace...
    expect(getWorkItemsForWorkspace(index, "w2").map((i) => i.runId)).not.toContain(runA);
    // ...and not in its run's either. It is simply gone.
    expect(getWorkItemsForWorkspace(index, "w1")).toEqual([]);
    expect(getAgentRunSummary(index, runA)!.workItems.total).toBe(0);
  });

  it("drops an artifact link whose file belongs to another workspace", () => {
    const { state, runA, fileB } = twoWorkspaces();

    // A link from w1's run to w2's file. Only editing stored state could
    // produce this; honouring it would be the leak.
    const tampered: AgentState = {
      ...state,
      artifactLinks: [
        ...state.artifactLinks,
        {
          id: "tampered-link",
          runId: runA,
          artifactId: fileB,
          role: "edited",
          createdAt: T0,
        },
      ],
    };

    const index = buildAgentDomainIndex(tampered);
    const impact = getAgentRunImpact(index, runA)!;

    expect(impact.artifacts.map((e) => e.artifact.artifactId)).not.toContain(fileB);
    expect(impact.artifacts).toHaveLength(1);
  });
});

describe("account isolation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setStorageNamespace(null);
  });

  afterEach(() => {
    setStorageNamespace(null);
    window.localStorage.clear();
  });

  /**
   * Accounts are separated by the storage namespace, one layer below this one.
   *
   * The intelligence layer is handed a single `AgentState` and has no way to
   * reach another, so what is verified here is that the separation actually
   * holds end to end: save as one account, switch, load as the other, and
   * confirm the derived view sees only its own work.
   */
  it("derives only the signed-in account's work", () => {
    const ada = withAgent();
    const adaRun = withRun(ada.state, {
      agentId: ada.agentId,
      workspaceId: "w1",
      title: "Ada session",
    });
    const adaState = withWorkItem(adaRun.state, {
      runId: adaRun.runId,
      title: "Ada work",
      status: "active",
    }).state;

    setStorageNamespace("account-ada");
    saveAgentState(adaState);

    const grace = withAgent();
    const graceRun = withRun(grace.state, {
      agentId: grace.agentId,
      workspaceId: "w1",
      title: "Grace session",
    });
    const graceState = withWorkItem(graceRun.state, {
      runId: graceRun.runId,
      title: "Grace work",
      status: "active",
    }).state;

    setStorageNamespace("account-grace");
    saveAgentState(graceState);

    // Same workspace id in both accounts — the confusable case.
    setStorageNamespace("account-ada");
    const adaLoad = loadAgentState();
    expect(adaLoad.status).toBe("loaded");
    const adaIndex = buildAgentDomainIndex(adaLoad.state);
    const adaActivity = getWorkspaceAgentActivity(adaIndex, "w1");

    expect(adaActivity.activeWorkItems.map((i) => i.title)).toEqual(["Ada work"]);
    expect(adaActivity.activeRuns.map((r) => r.title)).toEqual(["Ada session"]);

    setStorageNamespace("account-grace");
    const graceLoad = loadAgentState();
    expect(graceLoad.status).toBe("loaded");
    const graceIndex = buildAgentDomainIndex(graceLoad.state);
    const graceActivity = getWorkspaceAgentActivity(graceIndex, "w1");

    expect(graceActivity.activeWorkItems.map((i) => i.title)).toEqual(["Grace work"]);
    expect(graceActivity.activeRuns.map((r) => r.title)).toEqual(["Grace session"]);
  });
});

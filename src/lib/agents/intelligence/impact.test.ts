import { describe, expect, it } from "vitest";
import { buildAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { getAgentRelationshipsForRun, getHighlightedObjectIds } from "./relationships";
import {
  T0,
  withAgent,
  withArtifact,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";
import type { AgentObjectRelationship } from "./types";

/** A run that touched two files, three tabs and holds two work items. */
function impactful(workspaceId = "w1") {
  const base = withAgent();
  const run = withRun(base.state, { agentId: base.agentId, workspaceId });

  // Distinct creation times, so "plan order" is a real assertion rather than
  // an id comparison: items created in the same millisecond tie-break by id,
  // which is a UUID and says nothing about the plan.
  let state = withWorkItem(
    run.state,
    { runId: run.runId, title: "Implement authentication", status: "active" },
    T0
  ).state;
  state = withWorkItem(
    state,
    { runId: run.runId, title: "Add tests", status: "pending" },
    T0 + 1_000
  ).state;

  const auth = withArtifact(state, {
    runId: run.runId,
    path: "src/auth.ts",
    role: "edited",
  });
  state = auth.state;
  // Same file, second role.
  state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "inspected" }).state;
  const session = withArtifact(state, {
    runId: run.runId,
    path: "src/session.ts",
    role: "edited",
  });
  state = session.state;

  state = withTabLink(state, { runId: run.runId, tabId: "tab-docs", role: "context" });
  state = withTabLink(state, { runId: run.runId, tabId: "tab-spec", role: "context" });
  state = withTabLink(state, { runId: run.runId, tabId: "tab-app", role: "produced" });
  // A tab in both roles.
  state = withTabLink(state, { runId: run.runId, tabId: "tab-docs", role: "produced" });

  return {
    state,
    runId: run.runId,
    authId: auth.artifactId,
    sessionId: session.artifactId,
  };
}

describe("run impact", () => {
  it("reports every relationship the domain actually stores", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    expect(impact).toBeDefined();
    expect(impact!.workItems.map((item) => item.title)).toEqual([
      "Implement authentication",
      "Add tests",
    ]);
    expect(impact!.artifacts.map((entry) => entry.artifact.relativePath)).toEqual([
      "src/auth.ts",
      "src/session.ts",
    ]);
    expect(impact!.contextTabIds).toEqual(["tab-docs", "tab-spec"]);
    expect(impact!.producedTabIds).toEqual(["tab-app", "tab-docs"]);
  });

  it("collects several roles onto one file rather than listing it twice", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    const auth = impact!.artifacts.find((e) => e.artifact.relativePath === "src/auth.ts");
    expect(auth!.roles.sort()).toEqual(["edited", "inspected"]);
    // Two roles, still one file.
    expect(impact!.artifacts).toHaveLength(2);
  });

  it("counts a tab touched in both roles once as affected", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    // tab-docs is both context and produced; the union has three, not four.
    expect(impact!.affectedTabIds).toEqual(["tab-app", "tab-docs", "tab-spec"]);
  });

  it("distinguishes an unknown run from a run that touched nothing", () => {
    const base = withAgent();
    const bare = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const index = buildAgentDomainIndex(bare.state);

    expect(getAgentRunImpact(index, "no-such-run")).toBeUndefined();

    const empty = getAgentRunImpact(index, bare.runId);
    expect(empty).toBeDefined();
    expect(empty!.workItems).toEqual([]);
    expect(empty!.artifacts).toEqual([]);
    expect(empty!.affectedTabIds).toEqual([]);
  });

  /**
   * The Phase 13 boundary, restated at this layer.
   *
   * The project root is part of an artifact's *identity* — `workArtifactId`
   * builds the id from it — and it stays there. What must never happen is the
   * root reaching a field something renders. That is exactly the split
   * spatial/security.test.ts pins for `ArtifactSpatialNode`, and this layer
   * must not widen it.
   */
  it("keeps the project root to identity and out of every rendered field", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    for (const entry of impact!.artifacts) {
      // The absolute root is never a field of its own...
      expect(entry.artifact).not.toHaveProperty("projectPath");

      // ...and never appears in what is displayed.
      expect(entry.artifact.relativePath).not.toContain("projects/demo");
      expect(entry.artifact.relativePath.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(entry.artifact.relativePath)).toBe(false);

      // The id is an opaque key, and is allowed to carry it — as the scene's
      // `artifactId` already does. Asserted rather than assumed, so that a
      // future change to artifact identity is caught here too.
      expect(entry.artifact.artifactId).toContain("projects/demo");
    }
  });

  it("exposes exactly the fields a consumer needs, and no others", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    for (const entry of impact!.artifacts) {
      expect(Object.keys(entry.artifact).sort()).toEqual([
        "artifactId",
        "relativePath",
        "updatedAt",
      ]);
    }
  });

  it("never exposes a provider task id", () => {
    const { state, runId } = impactful();
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    for (const item of impact!.workItems) {
      expect(item).not.toHaveProperty("externalId");
    }
  });
});

describe("relationships", () => {
  it("emits one edge per stored row, and nothing else", () => {
    const { state, runId, authId, sessionId } = impactful();
    const relationships = getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId);

    const kinds = new Set(relationships.map((r) => r.kind));
    expect([...kinds].sort()).toEqual([
      "run-artifact",
      "run-context-tab",
      "run-produced-tab",
      "run-work-item",
    ]);

    // Two work items, three artifact-role rows, two context tabs, two
    // produced tabs.
    expect(count(relationships, "run-work-item")).toBe(2);
    expect(count(relationships, "run-artifact")).toBe(3);
    expect(count(relationships, "run-context-tab")).toBe(2);
    expect(count(relationships, "run-produced-tab")).toBe(2);

    const artifactTargets = relationships
      .filter((r) => r.kind === "run-artifact")
      .map((r) => r.targetId);
    expect(new Set(artifactTargets)).toEqual(new Set([authId, sessionId]));
  });

  it("carries the role on a file edge and nowhere else", () => {
    const { state, runId } = impactful();
    const relationships = getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId);

    for (const relationship of relationships) {
      if (relationship.kind === "run-artifact") expect(relationship.role).toBeDefined();
      else expect(relationship.role).toBeUndefined();
    }
  });

  /**
   * The central fail-closed guarantee of the phase.
   *
   * A run here has two work items and two files. A layer that joined them
   * through their shared run would emit four plausible work-item-to-file
   * edges, none of which anything observed. None may exist.
   */
  it("never joins a work item to a file through their shared run", () => {
    const { state, runId } = impactful();
    const relationships = getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId);
    const impact = getAgentRunImpact(buildAgentDomainIndex(state), runId);

    for (const relationship of relationships) {
      expect(relationship.kind).not.toBe("work-item-artifact");
      // Every edge starts at the run. There is no item-to-file edge to find.
      expect(relationship.runId).toBe(runId);
    }

    // And the impact model exposes no per-item file list either.
    for (const item of impact!.workItems) {
      expect(item).not.toHaveProperty("artifacts");
      expect(item).not.toHaveProperty("artifactIds");
      expect(item).not.toHaveProperty("files");
    }
  });

  it("produces stable ids across recomputation", () => {
    const { state, runId } = impactful();
    const first = getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId);
    const second = getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId);

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
    // And they are unique - an id collision would make two edges one.
    expect(new Set(first.map((r) => r.id)).size).toBe(first.length);
  });

  it("returns no edges for an unknown run", () => {
    const index = buildAgentDomainIndex(withAgent().state);
    expect(getAgentRelationshipsForRun(index, "no-such-run")).toEqual([]);
  });
});

describe("highlighting", () => {
  it("collects the objects a selected run touches, by kind", () => {
    const { state, runId, authId, sessionId } = impactful();
    const highlighted = getHighlightedObjectIds(buildAgentDomainIndex(state), runId);

    expect(highlighted.artifactIds).toEqual(new Set([authId, sessionId]));
    expect(highlighted.tabIds).toEqual(new Set(["tab-docs", "tab-spec", "tab-app"]));
    expect(highlighted.workItemIds.size).toBe(2);
  });

  it("highlights nothing when nothing is selected", () => {
    const { state } = impactful();
    const index = buildAgentDomainIndex(state);

    for (const selection of [null, undefined, ""]) {
      const highlighted = getHighlightedObjectIds(index, selection);
      expect(highlighted.workItemIds.size).toBe(0);
      expect(highlighted.artifactIds.size).toBe(0);
      expect(highlighted.tabIds.size).toBe(0);
    }
  });
});

function count(relationships: AgentObjectRelationship[], kind: string): number {
  return relationships.filter((relationship) => relationship.kind === kind).length;
}

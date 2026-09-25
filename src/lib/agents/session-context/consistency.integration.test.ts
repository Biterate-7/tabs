// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { ATTENDED_WINDOW_MS } from "./registry";
import { analyzeTopics } from "./topics";
import { collectionOverlap, rankCollections, recommendPlacement } from "./relevance";
import { validateWorkspacePlan } from "./plan";
import { largeSnapshot, studentSnapshot, tab } from "./__fixtures__/reasoning";
import { STUDENT, bind, call, closeServers, expectUntouched, harness, proposeApproveApply } from "./__fixtures__/harness";
import type { Harness } from "./__fixtures__/harness";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * One meaning per word (J.6 hardening): LIVE / PAUSED is whether the Command
 * Centre is syncing; STALE is whether a version something was based on is
 * still the session's version; a groupId is a reference to an exact set of
 * tabs and never a permission; "covers" / "overlap" mean the same thing in
 * every tool that says them, and never block a plan.
 */

afterEach(closeServers);

function edit(h: Harness, change: (tabs: typeof STUDENT.workspace.tabs) => typeof STUDENT.workspace.tabs) {
  const held = h.registry.binding("s1")!.snapshot;
  return h.registry.update("s1", { ...held, workspace: { ...held.workspace, tabs: change(held.workspace.tabs as typeof STUDENT.workspace.tabs) } });
}

describe("LIVE / PAUSED and STALE are different things", () => {
  it("a result can be stale while sync is live", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics")).json();
    expect(analysis).toMatchObject({ contextVersion: 1, sync: "live" });
    edit(h, (tabs) => [...tabs, tab("n1", "Tax return checklist", "https://tax.example.gov")]); // the Command Centre syncs: v2, live

    expect((await call(client, "get_context_status", { knownVersion: 1 })).json()).toMatchObject({ sync: "live", knownVersion: 1, stale: true, contextVersion: 2 });
    expect((await call(client, "get_topic_group", { groupId: analysis.groups[0].groupId, basedOnVersion: 1 })).json()).toMatchObject({ sync: "live", stale: true, contextVersion: 2 });
    await client.close();
  });

  it("a paused session's snapshot is not stale by itself — only a version change makes it so — and paused never blocks a read or moves the version", async () => {
    const h = harness();
    const client = await bind(h);
    h.clock.now += ATTENDED_WINDOW_MS + 1;
    const status = (await call(client, "get_context_status", { knownVersion: 1 })).json();
    expect(status).toMatchObject({ sync: "paused", knownVersion: 1, stale: false, contextVersion: 1 });
    for (const name of ["analyze_topics", "list_domains", "get_workspace_summary"]) expect((await call(client, name)).json().sync, name).toBe("paused");
    expect((await call(client, "find_related_tabs", { query: "relativity" })).isError).toBe(false);
    // The Command Centre comes back: live again, and still the same version.
    h.registry.attend("s1");
    expect((await call(client, "get_context_status", { knownVersion: 1 })).json()).toMatchObject({ sync: "live", stale: false, contextVersion: 1 });
    expectUntouched(h);
    await client.close();
  });

  it("uses one field for staleness everywhere a version is passed in, and none of the old names", async () => {
    const h = harness();
    const client = await bind(h);
    const answers = [
      (await call(client, "get_context_status", { knownVersion: 1 })).json(),
      (await call(client, "get_topic_group", { groupId: (await call(client, "analyze_topics")).json().groups[0].groupId, basedOnVersion: 1 })).json(),
      (await call(client, "preview_workspace_plan", { basedOnVersion: 0, operations: [{ kind: "create_collection", name: "X", tabIds: ["c1"] }] })).json(),
    ];
    for (const answer of answers) {
      expect(typeof answer.stale).toBe("boolean");
      expect(answer).not.toHaveProperty("fresh");
      expect(answer).not.toHaveProperty("workspaceChangedSince");
    }
    await client.close();
  });
});

describe("group ids are references, not permissions", () => {
  it("are the same while the workspace is unchanged — including after a sync that changes nothing", async () => {
    const h = harness();
    const client = await bind(h);
    const first = (await call(client, "analyze_topics", { maxGroups: 20 })).json().groups.map((group: { groupId: string }) => group.groupId);
    const held = h.registry.binding("s1")!.snapshot;
    expect(h.registry.update("s1", JSON.parse(JSON.stringify(held)))).toEqual({ version: 1, changed: false });
    const second = (await call(client, "analyze_topics", { maxGroups: 20 })).json().groups.map((group: { groupId: string }) => group.groupId);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    await client.close();
  });

  it("stay valid when the workspace changes outside the group — reported stale, the group still exactly the same tabs", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics")).json();
    const relativity = analysis.groups.find((group: { label: string }) => group.label === "General Relativity");
    // A tab in another group is renamed: that group changes; this one does not.
    edit(h, (tabs) => tabs.map((entry) => (entry.id === "c5" ? { ...entry, title: "College essay prompts 2026" } : entry)));
    const again = (await call(client, "get_topic_group", { groupId: relativity.groupId, basedOnVersion: 1 })).json();
    expect(again).toMatchObject({ found: true, stale: true, contextVersion: 2, groupId: relativity.groupId, tabCount: relativity.tabCount });
    await client.close();
  });

  it("never resolve to a different group when membership changes", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics")).json();
    const relativity = analysis.groups.find((group: { label: string }) => group.label === "General Relativity");
    // A new tab joins the topic: the group has new members, so it is a new group with a new id.
    edit(h, (tabs) => [...tabs, tab("p6", "General relativity problem set", "https://ocw.mit.edu/gr-problems")]);
    const old = (await call(client, "get_topic_group", { groupId: relativity.groupId, basedOnVersion: 1 })).json();
    expect(old).toMatchObject({ found: false, stale: true, contextVersion: 2 });
    expect(old.tabs).toBeUndefined();
    expect(old.label).toBeUndefined();
    const now = (await call(client, "analyze_topics")).json().groups.find((group: { label: string }) => group.label === "General Relativity");
    expect(now.groupId).not.toBe(relativity.groupId);
    expect(now.tabCount).toBe(relativity.tabCount + 1);
    await client.close();
  });

  it("are bound to their scope, their workspace and their exact form", async () => {
    const h = harness();
    const client = await bind(h);
    const all = (await call(client, "analyze_topics")).json().groups.map((group: { groupId: string }) => group.groupId);
    const unorganized = (await call(client, "analyze_topics", { uncategorizedOnly: true })).json().groups.map((group: { groupId: string }) => group.groupId);
    expect(all.every((id: string) => id.startsWith("t-"))).toBe(true);
    expect(unorganized.every((id: string) => id.startsWith("u-"))).toBe(true);
    for (const id of unorganized) expect((await call(client, "get_topic_group", { groupId: id })).json().found).toBe(true);

    // Another workspace's analysis: its ids resolve to nothing here.
    const other = analyzeTopics(largeSnapshot(50, 3)).groups.map((group) => group.groupId);
    for (const id of other.slice(0, 3)) expect((await call(client, "get_topic_group", { groupId: id })).json().found).toBe(false);
    // Anything but the exact form is refused by the schema.
    for (const id of ["t-1", "x-000000000000", `${all[0]} `, "t-GGGGGGGGGGGG", "../t-000000000000"]) expect((await call(client, "get_topic_group", { groupId: id })).isError, id).toBe(true);
    expectUntouched(h);
    await client.close();
  });

  it("cannot cause, authorize or target a change: no write accepts one, and a plan is its operations alone", async () => {
    const h = harness();
    const client = await bind(h);
    const { tools } = await client.listTools();
    const takesGroupId = tools.filter((tool) => JSON.stringify(tool.inputSchema).includes('"groupId"')).map((tool) => tool.name);
    expect(takesGroupId).toEqual(["get_topic_group"]);

    const [group] = (await call(client, "analyze_topics")).json().groups;
    // A "plan" that is only a group reference is not a plan.
    expect((await call(client, "propose_workspace_plan", { basedOnVersion: 1, groupId: group.groupId })).isError).toBe(true);
    expect((await call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "create_collection", groupId: group.groupId, name: "G" }] })).isError).toBe(true);
    expectUntouched(h);

    // Alongside real operations, a groupId is ignored: what is validated, shown and applied is the operations.
    const { approval } = await proposeApproveApply(h, client, {
      basedOnVersion: 1,
      groupId: group.groupId,
      operations: [{ kind: "create_collection", name: "Just these", tabIds: ["r1", "r2"], groupId: group.groupId }],
    } as never);
    expect(JSON.stringify(approval)).not.toContain(group.groupId);
    expect(approval.targets).toEqual(['Create collection "Just these" with 2 tabs']);
    await client.close();
  });
});

describe("collection overlap means one thing everywhere, and only advises", () => {
  function everySuggestion(snapshot: SessionContextSnapshot) {
    return [false, true].flatMap((uncategorizedOnly) =>
      analyzeTopics(snapshot, { uncategorizedOnly }).groups.map((group) =>
        recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, terms: group.terms, confidence: group.confidence })
      )
    );
  }

  it("never suggests creating a collection the plan preview would flag as a near-duplicate — on a real and a large workspace", () => {
    for (const snapshot of [studentSnapshot(), largeSnapshot(800, 30), largeSnapshot(50, 5)]) {
      for (const placement of everySuggestion(snapshot)) {
        if (!("operation" in placement)) continue;
        const operation = placement.operation;
        if (operation.kind === "create_collection") expect(collectionOverlap(snapshot, operation), operation.name).toBeUndefined();
        // And every suggestion is a valid J.5 plan.
        expect(validateWorkspacePlan(snapshot, { basedOnVersion: 1, operations: [operation] }, { workspaceId: snapshot.workspace.id, version: 1 }).ok).toBe(true);
      }
    }
  });

  it("find_relevant_collections' recommendation agrees with the ranking it lists", async () => {
    const h = harness();
    const client = await bind(h);
    const inputs = [
      { query: "physics", tabIds: ["p3", "p4", "p5"] },
      { query: "relativity", tabIds: ["p4", "p5"] },
      { query: "college applications", tabIds: ["c1", "c2", "c3"] },
      { query: "cooking", tabIds: ["r1"] },
      { tabIds: ["p3", "p5"] },
      // Only the query ties these to an existing collection: ranked with it, recommended with it.
      { query: "physics notes", tabIds: ["r1", "r2"] },
    ];
    for (const input of inputs) {
      const answer = (await call(client, "find_relevant_collections", input)).json();
      const top = answer.collections[0];
      for (const entry of answer.collections) if (entry.covers) expect(entry.score, entry.name).toBeGreaterThanOrEqual(1.2);
      if (top?.covers && answer.recommendation.action !== "none") {
        expect(answer.recommendation, JSON.stringify(input)).toMatchObject({ action: "add_to_existing", collection: { collectionId: top.collectionId } });
      }
      if (answer.recommendation.action === "create") {
        const preview = (await call(client, "preview_workspace_plan", { basedOnVersion: 1, operations: [answer.recommendation.operation] })).json();
        expect(preview.valid).toBe(true);
        expect(preview.overlaps, JSON.stringify(input)).toBeUndefined();
      }
    }
    expectUntouched(h);
    await client.close();
  });

  it("reports a partial fit by count and a full fit as covers — the same scores find_relevant_collections and the preview use", () => {
    const snapshot = studentSnapshot();
    const [physics] = rankCollections(snapshot, { tabIds: ["p1", "p3"] }).collections;
    expect(physics).toMatchObject({ name: "Physics", alreadyHolds: 1 });
    expect(collectionOverlap(snapshot, { name: "Relativity reading", tabIds: ["p3", "p4", "p5"] })?.name).toBe(
      rankCollections(snapshot, { query: "Relativity reading", tabIds: ["p3", "p4", "p5"] }).collections.find((entry) => entry.covers)?.name
    );
  });

  it("warns about a near-duplicate but never blocks it: the user may still approve it", async () => {
    const h = harness();
    const client = await bind(h);
    const plan = { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "Physics reading", tabIds: ["p3", "p4", "p5"] }] };
    const preview = (await call(client, "preview_workspace_plan", plan)).json();
    expect(preview).toMatchObject({ valid: true, overlaps: [{ operationIndex: 0, existingCollection: { name: "Physics" }, advice: expect.stringMatching(/does not block/) }] });
    await proposeApproveApply(h, client, plan);
    await client.close();
  });

  it("keeps the one blocking rule J.5's: the same name is refused, whatever the advice", async () => {
    const h = harness();
    const client = await bind(h);
    const preview = (await call(client, "preview_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "PHYSICS", tabIds: ["p3"] }] })).json();
    expect(preview).toMatchObject({ valid: false, problems: [{ code: "duplicate_name" }] });
    expectUntouched(h);
    await client.close();
  });
});

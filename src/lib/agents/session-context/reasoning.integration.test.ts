// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { STUDENT_TABS, largeSnapshot, tab } from "./__fixtures__/reasoning";
import { createSessionContextServer } from "./http";
import { ATTENDED_WINDOW_MS, createSessionContextRegistry } from "./registry";
import type { ApprovalOutcome, ContextApprovalRequest, SessionContextRegistry } from "./registry";
import type { SessionContextServer } from "./http";

/**
 * Workspace reasoning over the real thing (Phase J.6): the loopback server,
 * the session MCP server and the official MCP client. An agent analyzes,
 * explains, follows up on a group, finds a topic, asks which collection covers
 * it — all reads that ask no one and change nothing — and then turns a
 * suggestion into a change only through J.5: preview → propose → the user's
 * approval → the Command Centre's batch → verification.
 */

const J6_TOOLS = ["analyze_topics", "get_topic_group", "find_related_tabs", "find_relevant_collections", "list_domains"];

const COLLECTIONS = [{ id: "col-physics", workspaceId: "ws-student", name: "Physics", tabIds: ["p1", "p2"], createdAt: 1, updatedAt: 1 }];
const STUDENT = {
  workspace: { id: "ws-student", name: "Senior year", createdAt: 1, updatedAt: 2, tabs: STUDENT_TABS },
  collections: COLLECTIONS,
  dependencies: [{ id: "dep1", parentTabId: "p2", childTabId: "p4", createdAt: 1 }],
};
const PRIVATE = {
  workspace: { id: "ws-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [tab("t-bank", "College savings account statement", "https://bank.example.com/college")] },
  collections: [],
  dependencies: [],
};

const open: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
});

type Harness = {
  registry: SessionContextRegistry;
  server: SessionContextServer;
  asked: ContextApprovalRequest[];
  answer: (outcome: ApprovalOutcome) => void;
  clock: { now: number };
};

function harness(): Harness {
  const asked: ContextApprovalRequest[] = [];
  const answers: ((outcome: ApprovalOutcome) => void)[] = [];
  const clock = { now: 1_000_000 };
  const registry = createSessionContextRegistry({
    now: () => clock.now,
    approve: (request) => {
      asked.push(request);
      return new Promise((resolve) => answers.push(resolve));
    },
  });
  const server = createSessionContextServer({ registry });
  open.push(server);
  return { registry, server, asked, answer: (outcome) => answers.shift()?.(outcome), clock };
}

async function connect(h: Harness, token: string) {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(await h.server.url()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function bind(h: Harness, access: "read" | "read_write" = "read_write", snapshot: unknown = STUDENT) {
  const bound = await h.registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-student", access, snapshot });
  await h.registry.bind({ sessionId: "s2", ownerId: "local", workspaceId: "ws-private", access: "read_write", snapshot: PRIVATE });
  return connect(h, bound!.token);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
  return { result, text, json: () => JSON.parse(text) };
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The Command Centre's part, as J.5 does it: apply the approved plan with the store's batch, sync, report. */
function applyApproved(h: Harness) {
  const [action] = h.registry.pendingApplications("s1");
  const held = h.registry.binding("s1")!.snapshot;
  const applied = applyCollectionBatch(held.collections, { workspaceId: "ws-student", tabIds: new Set(held.workspace.tabs.map((entry) => entry.id)) }, action.plan!.operations, 9);
  if (!applied.ok) throw new Error("apply failed");
  h.registry.update("s1", { ...held, collections: applied.collections });
  expect(h.registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: applied.created })).toBe(true);
}

/** Nothing asked, nothing waiting to be applied, the version where it was. */
function expectUntouched(h: Harness, version = 1) {
  expect(h.asked).toEqual([]);
  expect(h.registry.pendingApplications("s1")).toEqual([]);
  expect(h.registry.binding("s1")!.version).toBe(version);
}

describe("reasoning tools are reads", () => {
  it("are offered to a read-only session, annotated read-only, and never asked about", async () => {
    const h = harness();
    const client = await bind(h, "read");
    const tools = (await client.listTools()).tools;
    for (const name of J6_TOOLS) expect(tools.find((entry) => entry.name === name)?.annotations?.readOnlyHint, name).toBe(true);
    expect(tools.map((entry) => entry.name)).not.toContain("propose_workspace_plan");

    await call(client, "analyze_topics");
    await call(client, "find_related_tabs", { query: "college applications" });
    const covered = (await call(client, "find_relevant_collections", { tabIds: ["p4", "p5"] })).json();
    // A suggestion reaches a read-only session as data it cannot act on.
    expect(covered.recommendation.status).toBe("Not applied. This session cannot change the workspace.");
    expect((await call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [covered.recommendation.operation] })).result.isError).toBe(true);
    expectUntouched(h);
    await client.close();
  });

  it("never reach a write path from a read-write session either — however they are called", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics", { maxGroups: 20 })).json();
    for (const group of analysis.groups) await call(client, "get_topic_group", { groupId: group.groupId, basedOnVersion: 1 });
    await call(client, "analyze_topics", { uncategorizedOnly: true });
    await call(client, "find_related_tabs", { tabIds: ["p2"] });
    await call(client, "find_relevant_collections", { query: "physics", tabIds: ["c2", "c3"] });
    await call(client, "list_domains", { uncategorizedOnly: true });
    await call(client, "find_duplicate_tabs");
    expectUntouched(h);

    // No tool applies a suggestion; unknown names are refused by the protocol.
    for (const name of ["apply_suggestion", "apply_topic_group", "organize_workspace"]) expect((await call(client, name)).result.isError, name).toBe(true);
    expectUntouched(h);
    await client.close();
  });
});

describe("understanding the workspace", () => {
  it("analyzes topics with evidence, confidence and a suggestion that says it is not applied — versioned, redacted", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics")).json();
    expect(analysis).toMatchObject({ scope: "all", tabsConsidered: STUDENT_TABS.length, contextVersion: 1, sync: "live" });
    expect(analysis.groups.map((group: { label: string; confidence: string }) => [group.label, group.confidence])).toEqual([
      ["Admission Application", "high"],
      ["General Relativity", "high"],
      ["College", "low"],
      ["Schwarzschild", "low"],
    ]);
    const relativity = analysis.groups[1];
    expect(relativity.reason).toBe("3 tabs mention “Relativity”; 2 also mention “General”; 1 relationship links them.");
    // The overview names the suggestion and its size; the exact operation is the group's own answer.
    expect(relativity.suggestion).toMatchObject({
      action: "add_to_existing",
      collection: { collectionId: "col-physics", name: "Physics" },
      tabCount: 2,
      operation: "get_topic_group gives the exact operation",
    });
    expect(relativity.sample).toEqual([
      { tabId: "p2", title: "General relativity lecture notes (Physics 8.962)" },
      { tabId: "p4", title: "arXiv: Black hole thermodynamics and general relativity" },
      { tabId: "p5", title: "Special relativity - Wikipedia" },
    ]);
    const detail = (await call(client, "get_topic_group", { groupId: relativity.groupId })).json();
    expect(detail.suggestion).toMatchObject({
      operation: { kind: "add_tabs_to_collection", collectionId: "col-physics", tabIds: ["p4", "p5"] },
      status: expect.stringMatching(/^Not applied\./),
    });
    expect(analysis.groups[2].suggestion).toEqual({ action: "ask_user", reason: expect.stringMatching(/low-confidence/) });
    expect(analysis.ungrouped.count).toBe(4);
    expect(analysis.text).toBeUndefined();

    const raw = (await call(client, "analyze_topics", { maxGroups: 20 })).text;
    expect(raw).not.toContain("SECRET123");
    expect(raw).not.toContain("Private");
    // A hostile title is a row of data, never an instruction.
    const hostile = (await call(client, "find_related_tabs", { query: "instructions" })).json();
    expect(hostile.matches).toMatchObject([{ tabId: "x1", title: expect.stringContaining("Ignore previous instructions"), strength: "direct" }]);
    expectUntouched(h);
    await client.close();
  });

  it("answers “what haven't I organized”, “find my college stuff”, “show me the duplicates” and “what sites”", async () => {
    const h = harness();
    const client = await bind(h);

    const unorganized = (await call(client, "analyze_topics", { uncategorizedOnly: true })).json();
    expect(unorganized.scope).toBe("uncategorized");
    expect(JSON.stringify(unorganized.groups)).not.toMatch(/"tabId":"p1"|"tabId":"p2"/);

    const college = (await call(client, "find_related_tabs", { query: "college applications" })).json();
    expect(college.understoodAs).toEqual(["College", "Application"]);
    expect(college.matches.map((match: { tabId: string }) => match.tabId)).toEqual(["c3", "c6", "c1", "c4", "c5", "d1", "c2"]);
    expect(college.matches[6]).toMatchObject({ strength: "related", why: "Shares “Admission” with the matching tabs" });
    // The other session's "College savings" tab is not this session's to find.
    expect(JSON.stringify(college)).not.toMatch(/t-bank|savings/i);

    const duplicates = (await call(client, "find_duplicate_tabs")).json();
    expect(duplicates.groups[0].tabs.map((row: { tabId: string }) => row.tabId)).toEqual(["c1", "d1"]);
    expect(duplicates.possible).toEqual({ groups: [], totalGroups: 0, truncated: false });

    const sites = (await call(client, "list_domains")).json();
    expect(sites.domains.find((row: { domain: string }) => row.domain === "wikipedia.org")).toMatchObject({
      site: "Wikipedia",
      tabs: 2,
      unorganized: 1,
      collections: [{ collectionId: "col-physics", name: "Physics", tabs: 1 }],
    });

    const none = await call(client, "find_related_tabs", {});
    expect(none.result.isError).toBe(true);
    expect((await call(client, "find_related_tabs", { query: "the of and" })).json()).toMatchObject({ matches: [], note: expect.stringMatching(/no searchable words/) });
    expectUntouched(h);
    await client.close();
  });

  it("refuses malformed requests at the schema, and counts another workspace's ids without echoing them", async () => {
    const h = harness();
    const client = await bind(h);
    for (const [name, args] of [
      ["get_topic_group", { groupId: "../../etc/passwd" }],
      ["get_topic_group", { groupId: "t-XYZ" }],
      ["get_topic_group", {}],
      ["analyze_topics", { maxGroups: 0 }],
      ["analyze_topics", { maxGroups: 10_000 }],
      ["find_related_tabs", { query: "x".repeat(500) }],
      ["find_related_tabs", { tabIds: [] }],
      ["find_relevant_collections", { tabIds: Array.from({ length: 300 }, (_, index) => `t${index}`) }],
    ] as const) {
      expect((await call(client, name, args)).result.isError, `${name} ${JSON.stringify(args).slice(0, 40)}`).toBe(true);
    }
    const foreign = (await call(client, "find_related_tabs", { tabIds: ["t-bank", "p2"] })).json();
    expect(foreign.unknownTabIds).toBe(1);
    expect(JSON.stringify(foreign)).not.toContain("t-bank");
    const foreignCollections = (await call(client, "find_relevant_collections", { tabIds: ["t-bank"] })).json();
    expect(foreignCollections.recommendation).toEqual({ action: "none", reason: "None of those are tabs of this workspace." });
    expectUntouched(h);
    await client.close();
  });
});

describe("multi-turn reasoning against a changing workspace", () => {
  it("follows up on a group while it stands, says when the workspace moved, and refuses to describe a group that no longer exists", async () => {
    const h = harness();
    const client = await bind(h);
    const analysis = (await call(client, "analyze_topics")).json();
    const second = analysis.groups[1];

    // "Tell me more about the second one."
    const more = (await call(client, "get_topic_group", { groupId: second.groupId, basedOnVersion: 1 })).json();
    expect(more).toMatchObject({ found: true, label: "General Relativity", basedOnVersion: 1, stale: false, contextVersion: 1 });
    expect(more.tabs.map((row: { tabId: string; why: string }) => [row.tabId, row.why])).toEqual([
      ["p2", "Title mentions “Relativity” and “General”"],
      ["p4", "Title mentions “Relativity” and “General”"],
      ["p5", "Title mentions “Relativity”"],
    ]);

    // The user adds an unrelated tab in Hubble: version 2, the group untouched.
    const held = h.registry.binding("s1")!.snapshot;
    h.registry.update("s1", { ...held, workspace: { ...held.workspace, tabs: [...held.workspace.tabs, tab("n1", "Tax return checklist", "https://tax.example.gov")] } });
    const still = (await call(client, "get_topic_group", { groupId: second.groupId, basedOnVersion: 1 })).json();
    expect(still).toMatchObject({ found: true, basedOnVersion: 1, stale: true, contextVersion: 2, note: expect.stringMatching(/still exactly the same tabs/) });

    // The user renames a member away from the topic: the old group is gone, and the agent is told so.
    const now = h.registry.binding("s1")!.snapshot;
    h.registry.update("s1", {
      ...now,
      workspace: { ...now.workspace, tabs: now.workspace.tabs.map((entry) => (entry.id === "p5" ? { ...entry, title: "Cookie decorating ideas" } : entry)) },
    });
    const gone = (await call(client, "get_topic_group", { groupId: second.groupId, basedOnVersion: 1 })).json();
    expect(gone).toMatchObject({ found: false, basedOnVersion: 1, stale: true, contextVersion: 3, note: expect.stringMatching(/Run analyze_topics again/) });
    expect(gone.label).toBeUndefined();
    expectUntouched(h, 3);
    await client.close();
  });

  it("refuses a suggestion proposed against an analysis the workspace has moved past — before anyone is asked", async () => {
    const h = harness();
    const client = await bind(h);
    const overview = (await call(client, "analyze_topics")).json().groups[1];
    const relativity = (await call(client, "get_topic_group", { groupId: overview.groupId })).json();
    const held = h.registry.binding("s1")!.snapshot;
    h.registry.update("s1", { ...held, workspace: { ...held.workspace, name: "Senior year (renamed)" } });
    const stale = await call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [relativity.suggestion.operation] });
    expect(stale.result.isError).toBe(true);
    expect(stale.text).toMatch(/now at context version 2/);
    expect(h.asked).toEqual([]);
    await client.close();
  });
});

describe("from reasoning to a change — only through J.5", () => {
  it("finds a topic, checks which collection covers it, previews, proposes, and changes nothing until the user approves the exact plan", async () => {
    const h = harness();
    const client = await bind(h);

    // "Find my college application stuff" → "Organize those."
    const found = (await call(client, "find_related_tabs", { query: "college applications" })).json();
    const tabIds = found.matches.map((match: { tabId: string }) => match.tabId);
    const covered = (await call(client, "find_relevant_collections", { query: "college applications", tabIds })).json();
    expect(covered.collections).toEqual([]);
    expect(covered.recommendation).toMatchObject({
      action: "create",
      operation: { kind: "create_collection", name: "College Applications", tabIds: ["c3", "c6", "c1", "c4", "c5", "d1", "c2"] },
      status: expect.stringMatching(/^Not applied\./),
    });
    expectUntouched(h);

    const plan = { basedOnVersion: covered.contextVersion, operations: [{ ...covered.recommendation.operation, reason: "Everything about college applications", confidence: "high" }] };
    const preview = (await call(client, "preview_workspace_plan", plan)).json();
    expect(preview).toMatchObject({ valid: true, changes: ['Create collection "College Applications" with 7 tabs'] });
    expectUntouched(h);

    // Proposed: one approval, and nothing applied while the user decides.
    const pending = call(client, "propose_workspace_plan", plan);
    await until(() => h.asked.length === 1);
    expect(h.asked[0].plan?.steps.map((step) => step.kind)).toEqual(["create_collection"]);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    expect(h.registry.binding("s1")!.snapshot.collections.map((collection) => collection.name)).toEqual(["Physics"]);

    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    applyApproved(h);
    const result = (await pending).json();
    expect(result).toMatchObject({ applied: true, verified: true, previousVersion: 1, contextVersion: 2 });

    // The agent verifies by reading again: the college tabs are organized now.
    const collections = (await call(client, "list_collections")).json();
    expect(collections.collections.map((collection: { name: string; tabCount: number }) => [collection.name, collection.tabCount])).toEqual([
      ["Physics", 2],
      ["College Applications", 7],
    ]);
    const after = (await call(client, "find_relevant_collections", { query: "college applications", tabIds })).json();
    expect(after.recommendation).toEqual({ action: "none", reason: "Already organized: all of them are in “College Applications”." });
    const unorganized = (await call(client, "analyze_topics", { uncategorizedOnly: true })).json();
    expect(JSON.stringify(unorganized)).not.toMatch(/"tabId":"c[1-6]"/);
    await client.close();
  });

  it("changes nothing when the user declines a reasoned plan", async () => {
    const h = harness();
    const client = await bind(h);
    const overview = (await call(client, "analyze_topics")).json().groups[1];
    const relativity = (await call(client, "get_topic_group", { groupId: overview.groupId })).json();
    const pending = call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [relativity.suggestion.operation] });
    await until(() => h.asked.length === 1);
    h.answer("denied");
    expect((await pending).text).toBe("The user declined this plan. Nothing was changed.");
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    expect(h.registry.binding("s1")!.snapshot.collections).toEqual(COLLECTIONS.map(({ ...collection }) => collection));
    await client.close();
  });
});

describe("collection reasoning in a plan check", () => {
  it("warns that a new collection would duplicate one that covers its tabs — advice only, the plan stays valid", async () => {
    const h = harness();
    const client = await bind(h);
    const overlapping = (
      await call(client, "preview_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "Physics reading", tabIds: ["p4", "p5"] }] })
    ).json();
    expect(overlapping).toMatchObject({
      valid: true,
      overlaps: [{ operationIndex: 0, existingCollection: { collectionId: "col-physics", name: "Physics" }, advice: expect.stringMatching(/add_tabs_to_collection/) }],
    });
    const distinct = (
      await call(client, "preview_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "Baking", tabIds: ["r1", "r2"] }] })
    ).json();
    expect(distinct.valid).toBe(true);
    expect(distinct.overlaps).toBeUndefined();
    expectUntouched(h);
    await client.close();
  });
});

describe("freshness", () => {
  it("is live while the Command Centre asks about the session, paused once it stops, and live again when it returns", async () => {
    const h = harness();
    const client = await bind(h);
    expect((await call(client, "get_context_status")).json()).toMatchObject({ sync: "live", contextVersion: 1 });

    h.clock.now += ATTENDED_WINDOW_MS + 1;
    const paused = (await call(client, "get_context_status")).json();
    expect(paused).toMatchObject({ sync: "paused", lastSeenAt: 1_000_000, contextVersion: 1 });
    // Paused never blocks a read or moves a version.
    expect((await call(client, "analyze_topics")).json()).toMatchObject({ sync: "paused", contextVersion: 1 });
    expect((await call(client, "get_workspace_summary")).json()).toMatchObject({ sync: "paused" });

    h.registry.attend("s1");
    expect((await call(client, "find_related_tabs", { query: "physics" })).json()).toMatchObject({ sync: "live" });
    h.clock.now += ATTENDED_WINDOW_MS + 1;
    // A sync is the Command Centre too.
    h.registry.update("s1", h.registry.binding("s1")!.snapshot);
    expect((await call(client, "list_domains")).json()).toMatchObject({ sync: "live", contextVersion: 1 });
    expectUntouched(h);
    await client.close();
  });

  it("does not let one session's attendance speak for another", async () => {
    const h = harness();
    await bind(h);
    h.clock.now += ATTENDED_WINDOW_MS + 1;
    h.registry.attend("s2");
    expect(h.registry.freshness("s1")?.sync).toBe("paused");
    expect(h.registry.freshness("s2")?.sync).toBe("live");
    h.registry.release("s1");
    expect(h.registry.freshness("s1")).toBeUndefined();
    h.registry.attend("s1");
    expect(h.registry.freshness("s1")).toBeUndefined();
  });
});

describe("large workspaces over MCP", () => {
  it("answers 800 tabs in bounded, small responses", async () => {
    const h = harness();
    const bound = await h.registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-large", access: "read_write", snapshot: largeSnapshot(800, 30) });
    const client = await connect(h, bound!.token);
    const analysis = await call(client, "analyze_topics", { maxGroups: 20 });
    expect(analysis.json().groups.length).toBeGreaterThanOrEqual(10);
    expect(analysis.json().groups.length).toBeLessThanOrEqual(20);
    expect(analysis.text.length).toBeLessThan(64 * 1024);
    const group = await call(client, "get_topic_group", { groupId: analysis.json().groups[0].groupId });
    expect(group.json().tabs.length).toBeLessThanOrEqual(100);
    expect(group.text.length).toBeLessThan(64 * 1024);
    const related = await call(client, "find_related_tabs", { query: "astronomy lecture", maxResults: 50 });
    expect(related.json().matches.length).toBe(50);
    expect(related.text.length).toBeLessThan(64 * 1024);
    expect((await call(client, "list_domains")).text.length).toBeLessThan(16 * 1024);
    await client.close();
  });
});

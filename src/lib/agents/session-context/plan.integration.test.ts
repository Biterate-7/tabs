// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { createSessionContextServer } from "./http";
import { createSessionContextRegistry } from "./registry";
import type { ApprovalOutcome, ContextApprovalRequest, SessionContextRegistry } from "./registry";
import type { SessionContextServer } from "./http";

/**
 * Workspace intelligence and plans over the real thing (Phase J.5): the
 * loopback server, the session MCP server and the official MCP client — the
 * client code agents use. An agent reads the workspace's shape, checks a plan,
 * proposes it, and gets back what was applied and verified; the approval and
 * the application are Hubble's.
 */

function tab(id: string, title: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, title, ...extra };
}

const LAUNCH = {
  workspace: {
    id: "ws-launch",
    name: "Launch Plan",
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      tab("t1", "MIT admissions", "https://mit.edu/admissions"),
      tab("t2", "MIT admissions copy", "https://mit.edu/admissions"),
      tab("t3", "Stanford essays", "https://stanford.edu/essays"),
      tab("t4", "Physics lecture", "https://ocw.mit.edu/physics"),
      tab("t5", "Signed report", "https://files.example.com/r?access_token=SECRET123"),
    ],
  },
  collections: [{ id: "c1", workspaceId: "ws-launch", name: "Collection 2", tabIds: ["t4"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};
const PRIVATE = {
  workspace: { id: "ws-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [tab("t-bank", "Bank", "https://bank.example.com")] },
  collections: [{ id: "c-bank", workspaceId: "ws-private", name: "Money", tabIds: ["t-bank"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};

const PLAN = {
  basedOnVersion: 1,
  operations: [
    { kind: "create_collection", name: "College Research", tabIds: ["t1", "t3"], reason: "Admissions and essays", confidence: "high" },
    { kind: "rename_collection", collectionId: "c1", name: "Physics" },
  ],
};

const open: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
});

type Harness = { registry: SessionContextRegistry; server: SessionContextServer; asked: ContextApprovalRequest[]; answer: (outcome: ApprovalOutcome) => void };

function harness(): Harness {
  const asked: ContextApprovalRequest[] = [];
  const answers: ((outcome: ApprovalOutcome) => void)[] = [];
  const registry = createSessionContextRegistry({
    approve: (request) => {
      asked.push(request);
      return new Promise((resolve) => answers.push(resolve));
    },
  });
  const server = createSessionContextServer({ registry });
  open.push(server);
  return { registry, server, asked, answer: (outcome) => answers.shift()?.(outcome) };
}

async function bind(h: Harness, access: "read" | "read_write" = "read_write") {
  const bound = await h.registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-launch", access, snapshot: LAUNCH });
  await h.registry.bind({ sessionId: "s2", ownerId: "local", workspaceId: "ws-private", access: "read_write", snapshot: PRIVATE });
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(await h.server.url()), { requestInit: { headers: { Authorization: `Bearer ${bound!.token}` } } })
  );
  return { client, token: bound!.token };
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? "";
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { result, text: text(result), json: () => JSON.parse(text(result)) };
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The Command Centre's part: apply the approved plan with the store's batch, sync, report. */
function applyApproved(h: Harness) {
  const [action] = h.registry.pendingApplications("s1");
  const held = h.registry.binding("s1")!.snapshot;
  const applied = applyCollectionBatch(held.collections, { workspaceId: "ws-launch", tabIds: new Set(held.workspace.tabs.map((entry) => entry.id)) }, action.plan!.operations, 9);
  if (!applied.ok) throw new Error("apply failed");
  h.registry.update("s1", { ...held, collections: applied.collections });
  expect(h.registry.complete("s1", action.id, { ok: true, planHash: action.plan!.hash, created: applied.created })).toBe(true);
}

describe("reading the workspace's shape", () => {
  it("offers the new tools by capability: a read-only session can check a plan but has no way to propose one", async () => {
    const h = harness();
    const { client } = await bind(h, "read");
    const tools = (await client.listTools()).tools;
    const names = tools.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["get_workspace_summary", "find_duplicate_tabs", "preview_workspace_plan"]));
    expect(names).not.toContain("propose_workspace_plan");
    expect(tools.find((entry) => entry.name === "preview_workspace_plan")?.annotations?.readOnlyHint).toBe(true);
    const refused = await call(client, "propose_workspace_plan", PLAN);
    expect(refused.result.isError).toBe(true);
    expect(h.asked).toEqual([]);
    await client.close();
  });

  it("summarizes, searches with memberships, and finds duplicates — bounded, redacted, versioned", async () => {
    const h = harness();
    const { client, token } = await bind(h);

    const summary = (await call(client, "get_workspace_summary")).json();
    expect(summary).toMatchObject({
      workspace: { workspaceId: "ws-launch", name: "Launch Plan" },
      tabs: { total: 5, uncategorized: 4 },
      collections: { total: 1, list: [{ collectionId: "c1", name: "Collection 2", tabCount: 1 }] },
      duplicates: { groups: 1, tabs: 2 },
      contextVersion: 1,
      canChangeWorkspace: true,
    });

    const search = (await call(client, "search_tabs", { query: "mit" })).json();
    expect(search.items.map((item: { sourceId: string }) => item.sourceId)).toEqual(["t1", "t2", "t4"]);
    expect(search.memberships).toEqual([{ tabId: "t4", collectionId: "c1", collection: "Collection 2" }]);
    expect(search.contextVersion).toBe(1);
    const uncategorized = (await call(client, "search_tabs", { query: "mit", uncategorizedOnly: true })).json();
    expect(uncategorized.items.map((item: { sourceId: string }) => item.sourceId)).toEqual(["t1", "t2"]);
    expect((await call(client, "search_tabs", { query: "SECRET123" })).json()).toMatchObject({ matches: 0, totalMatches: 0 });

    const listed = (await call(client, "list_tabs", { uncategorizedOnly: true })).json();
    expect(listed.total).toBe(4);

    const duplicates = (await call(client, "find_duplicate_tabs")).json();
    expect(duplicates.groups).toHaveLength(1);
    expect(duplicates.groups[0].tabs.map((entry: { tabId: string }) => entry.tabId)).toEqual(["t1", "t2"]);

    const everything = JSON.stringify([summary, search, listed, duplicates]);
    expect(everything).not.toContain("SECRET123");
    expect(everything).not.toContain(token);
    expect(everything).not.toMatch(/ws-private|t-bank|Bank/);
    await client.close();
  });
});

describe("plans over MCP", () => {
  it("checks a plan without asking anyone, and lists every problem of a bad one", async () => {
    const h = harness();
    const { client } = await bind(h);
    const good = (await call(client, "preview_workspace_plan", PLAN)).json();
    // J.6 hardening: the preview states the whole proposal contract — workspace, version, the exact
    // (normalized) operations, what they touch, and that approval is required and not yet requested.
    expect(good).toEqual({
      valid: true,
      workspace: { workspaceId: "ws-launch", name: "Launch Plan" },
      basedOnVersion: 1,
      operations: PLAN.operations,
      changes: ['Create collection "College Research" with 2 tabs', 'Rename collection "Collection 2" to "Physics"'],
      affected: {
        tabs: 2,
        createsCollections: ["College Research"],
        renamesCollections: [{ from: "Collection 2", to: "Physics" }],
        addsToCollections: [],
        movesTabsOutOf: [],
      },
      approval: expect.stringMatching(/^required — not requested yet/),
      canApply: true,
      contextVersion: 1,
      note: "Checked only. Nothing has changed and no one was asked. No other tabs or collections would change.",
    });
    const bad = (
      await call(client, "preview_workspace_plan", {
        basedOnVersion: 1,
        operations: [
          { kind: "create_collection", name: "collection 2", tabIds: ["t1"] },
          { kind: "add_tabs_to_collection", collectionId: "c-bank", tabIds: ["t-bank"] },
        ],
      })
    ).json();
    expect(bad).toMatchObject({ valid: false, problems: [{ operationIndex: 0, code: "duplicate_name" }, { operationIndex: 1, code: "unknown_collection" }] });
    expect(JSON.stringify(bad)).not.toContain("Bank");
    expect(h.asked).toEqual([]);
    await client.close();
  });

  it("refuses unknown, oversized, cross-workspace and stale plans before anyone is asked", async () => {
    const h = harness();
    const { client } = await bind(h);
    const unknown = await call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "delete_collection", collectionId: "c1" }] });
    expect(unknown.result.isError).toBe(true);
    const oversized = await call(client, "propose_workspace_plan", {
      basedOnVersion: 1,
      operations: Array.from({ length: 21 }, (_, index) => ({ kind: "create_collection", name: `N${index}`, tabIds: ["t1"] })),
    });
    expect(oversized.result.isError).toBe(true);
    const elsewhere = await call(client, "propose_workspace_plan", { ...PLAN, workspaceId: "ws-private" });
    expect(elsewhere.text).toBe("This session can only read the Hubble workspace it was started from.");
    const foreign = await call(client, "propose_workspace_plan", { basedOnVersion: 1, operations: [{ kind: "rename_collection", collectionId: "c-bank", name: "Mine" }] });
    expect(foreign.result.isError).toBe(true);
    expect(foreign.text).toMatch(/^The plan was not proposed and nothing was changed\./);
    const stale = await call(client, "propose_workspace_plan", { ...PLAN, basedOnVersion: 0 });
    expect(stale.text).toMatch(/it is now at context version 1\. Nothing was changed\./);
    expect(h.asked).toEqual([]);
    expect(h.registry.binding("s2")?.snapshot.collections[0].name).toBe("Money");
    await client.close();
  });

  it("proposes, waits for the user, applies once, verifies — and the agent can check the result itself", async () => {
    const h = harness();
    const { client, token } = await bind(h);
    const pending = call(client, "propose_workspace_plan", PLAN);
    await until(() => h.asked.length === 1);
    // Nothing to apply until the user answers.
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    expect(h.asked[0].plan?.steps[0]).toMatchObject({ subject: "College Research", reason: "Admissions and essays", confidence: "high" });
    expect(JSON.stringify(h.asked[0])).not.toContain(token);

    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);
    applyApproved(h);

    const done = (await pending).json();
    expect(done).toMatchObject({
      applied: true,
      verified: true,
      previousVersion: 1,
      contextVersion: 2,
      results: [
        { step: 1, change: 'Create collection "College Research" with 2 tabs', verified: true },
        { step: 2, change: 'Rename collection "Collection 2" to "Physics"', verified: true, collectionId: "c1" },
      ],
    });
    const created = done.results[0].collectionId;

    // The agent's own verification, through ordinary reads.
    const status = (await call(client, "get_context_status", { knownVersion: 1 })).json();
    expect(status).toMatchObject({ contextVersion: 2, knownVersion: 1, stale: true });
    const changes = (await call(client, "get_context_changes", { sinceVersion: 1 })).json();
    expect(new Set(changes.collections.changed)).toEqual(new Set([created, "c1"]));
    const collection = (await call(client, "get_collection", { collectionId: created })).json();
    expect(JSON.stringify(collection.items)).toContain("College Research");
    expect(collection.items.filter((item: { sourceType: string }) => item.sourceType === "tab").map((item: { sourceId: string }) => item.sourceId)).toEqual(["t1", "t3"]);
    await client.close();
  });

  it("tells the agent plainly when the user declines, and changes nothing", async () => {
    const h = harness();
    const { client } = await bind(h);
    const pending = call(client, "propose_workspace_plan", PLAN);
    await until(() => h.asked.length === 1);
    h.answer("denied");
    const declined = await pending;
    expect(declined.result.isError).toBe(true);
    expect(declined.text).toBe("The user declined this plan. Nothing was changed.");
    expect(h.registry.binding("s1")?.version).toBe(1);
    await client.close();
  });
});

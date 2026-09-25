// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionContextMcpServer } from "@/lib/mcp/server";
import { toolStage } from "@/lib/agents/command-centre/presentation";
import { SESSION_CONTEXT_TOOLS } from "./capabilities";
import { createSessionContextRegistry } from "./registry";
import { STUDENT } from "./__fixtures__/harness";
import type { SessionMcpScope } from "@/lib/mcp/server";

/**
 * The mutation boundary, proven by behaviour rather than by reading source
 * (J.6 hardening). A session's MCP server is built over a scope whose two
 * write paths — `requestChange` and `requestPlan`, the only ways anything
 * reaches the user's approval — are spies. Every tool the server offers is
 * called with real arguments: the read tools never touch a spy, each write
 * tool touches exactly its own once, and the Command Centre's stage for each
 * tool agrees with what the server says it is.
 *
 * The source guards in operations.security.test.ts stay as defence in depth;
 * this is the guarantee that does not depend on how the code is written.
 */

const WRITES = ["create_collection", "rename_collection", "add_tabs_to_collection", "propose_workspace_plan"];

/** One real call per tool, over the student workspace. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_workspace_summary: {},
  get_context_status: { knownVersion: 1 },
  get_context_changes: { sinceVersion: 0 },
  get_current_workspace: { maxTabs: 50, includeNotes: true },
  list_workspaces: {},
  get_workspace: { workspaceId: "ws-student", maxTabs: 50 },
  list_tabs: { limit: 100 },
  get_tabs: { tabIds: ["c1", "p1"], includeNotes: true },
  search_tabs: { query: "college", includeNotes: true },
  find_duplicate_tabs: {},
  analyze_topics: { maxGroups: 20 },
  get_topic_group: { groupId: "t-000000000000", basedOnVersion: 1 },
  find_related_tabs: { query: "college applications", tabIds: ["p2"] },
  find_relevant_collections: { query: "physics", tabIds: ["p3", "p4"] },
  list_domains: { uncategorizedOnly: true },
  list_collections: {},
  get_collection: { collectionId: "col-physics" },
  preview_workspace_plan: { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "College", tabIds: ["c1", "c2"] }] },
  get_tab_graph: { tabId: "p2", depth: 2 },
  create_collection: { name: "College", tabIds: ["c1", "c2"] },
  rename_collection: { collectionId: "col-physics", name: "Relativity" },
  add_tabs_to_collection: { collectionId: "col-physics", tabIds: ["p3"] },
  propose_workspace_plan: { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "College", tabIds: ["c1", "c2"] }] },
};

async function spiedServer() {
  const registry = createSessionContextRegistry({ approve: async () => "denied" });
  await registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-student", access: "read_write", snapshot: STUDENT });
  const writes: string[] = [];
  const scope: SessionMcpScope = {
    binding: () => registry.binding("s1"),
    authority: () => registry.authority("s1"),
    changesSince: (since) => registry.changesSince("s1", since),
    freshness: () => registry.freshness("s1"),
    previewPlan: (input) => registry.previewPlan("s1", input),
    requestChange: async (change) => {
      writes.push(`change:${change.kind}`);
      return { ok: false, reason: "denied" };
    },
    requestPlan: async () => {
      writes.push("plan");
      return { ok: false, reason: "denied" };
    },
  };
  const server = createSessionContextMcpServer({ scope });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "1" });
  await client.connect(clientSide);
  return { client, writes, registry };
}

describe("the mutation boundary, by behaviour", () => {
  it("offers every session tool, and has arguments here for each — a new tool must be added deliberately", async () => {
    const { client } = await spiedServer();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...SESSION_CONTEXT_TOOLS].sort());
    expect(Object.keys(ARGS).sort()).toEqual(names);
    await client.close();
  });

  it("lets no read tool reach a write path — each is called for real and no proposal is ever made", async () => {
    const { client, writes, registry } = await spiedServer();
    const tools = (await client.listTools()).tools;
    for (const tool of tools.filter((entry) => !WRITES.includes(entry.name))) {
      const result = (await client.callTool({ name: tool.name, arguments: ARGS[tool.name] })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError, `${tool.name}: ${result.content[0]?.text}`).toBeFalsy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
    expect(writes).toEqual([]);
    expect(registry.pendingApplications("s1")).toEqual([]);
    expect(registry.binding("s1")!.version).toBe(1);
    await client.close();
  });

  it("routes each write tool through exactly one proposal to the user, and nothing else", async () => {
    const { client, writes } = await spiedServer();
    const tools = (await client.listTools()).tools;
    for (const name of WRITES) {
      const before = writes.length;
      await client.callTool({ name, arguments: ARGS[name] });
      expect(writes.length - before, name).toBe(1);
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(writes).toEqual(["change:create_collection", "change:rename_collection", "change:add_tabs_to_collection", "plan"]);
    await client.close();
  });

  it("labels a tool Proposing in the Command Centre exactly when the server says it is not read-only", async () => {
    const { client } = await spiedServer();
    for (const tool of (await client.listTools()).tools) {
      const stage = toolStage(`mcp__tabdump_abcdefghijklmnop__${tool.name}`);
      expect(stage, tool.name).toBeDefined();
      expect(stage === "proposing", tool.name).toBe(tool.annotations?.readOnlyHint === false);
    }
    await client.close();
  });
});

describe("the session server's reach, by source (defence in depth)", () => {
  const SRC = path.resolve(__dirname, "../../..");
  const code = readFileSync(path.join(SRC, "lib/mcp/server.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => ({ typeOnly: Boolean(match[1]), from: match[2] }));

  it("imports no filesystem, process, network, storage, approval, control or store module at runtime", () => {
    const runtime = imports.filter((entry) => !entry.typeOnly).map((entry) => entry.from);
    for (const from of runtime) {
      expect(from, from).not.toMatch(/^node:|^(fs|child_process|net|http|https|os)$|control\/|approvals|broker|use-collection-store|collections\/(batch|relations)|storage/);
    }
    // The registry — which holds the approver — is reached only through the scope it is given.
    expect(runtime).not.toContain("@/lib/agents/session-context/registry");
    expect(code).not.toMatch(/\beval\(|new Function\(|process\.|localStorage|indexedDB|\bfetch\(/);
  });
});

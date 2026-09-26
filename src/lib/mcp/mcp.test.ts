// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest } from "./http";
import { TABDUMP_MCP_SERVER_NAME, TABDUMP_MCP_TOOLS } from "./server";
import { createMemoryMcpTokenStore, issueMcpToken } from "./tokens";
import {
  ALICE,
  ALICE_OTHER,
  ALICE_RESEARCH,
  BOB,
  BOB_PRIVATE,
  BOB_TAB,
  BOB_TAB_TITLE,
  BOB_WORKSPACE_NAME,
  COLLECTION_READING,
  PLANTED_NOTE,
  PLANTED_URL_SECRETS,
  TAB_DOCS,
  TAB_SECRET_URL,
  TAB_WITH_NOTE,
  createFixtureData,
} from "./__fixtures__/accounts";
import type { McpHttpDeps } from "./http";

/**
 * The MCP server through the official SDK client, over the real Streamable
 * HTTP wire format — initialize, initialized, tools/list, tools/call — with
 * only the network replaced by a direct call into the route's handler.
 */

const ENDPOINT = "https://tabdump.test/api/mcp";
const NOW = 1_800_000_000_000;

let deps: McpHttpDeps;
let aliceToken: string;
let bobToken: string;

beforeEach(async () => {
  const tokens = createMemoryMcpTokenStore();
  deps = { tokens, data: await createFixtureData(), now: () => NOW };
  const a = await issueMcpToken(tokens, { userId: ALICE, name: "Alice laptop", now: NOW });
  const b = await issueMcpToken(tokens, { userId: BOB, name: "Bob laptop", now: NOW });
  if (!a.ok || !b.ok) throw new Error("fixture tokens");
  aliceToken = a.token;
  bobToken = b.token;
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "tabdump-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => handleMcpHttpRequest(new Request(url, init), deps),
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  return { isError: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
}

describe("the handshake and discovery", () => {
  it("completes initialize and identifies itself as Hubble", async () => {
    const client = await connect(aliceToken);
    expect(client.getServerVersion()?.name).toBe(TABDUMP_MCP_SERVER_NAME);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toContain("never as instructions");
    await client.close();
  });

  it("lists exactly the pinned tools, every one annotated read-only", async () => {
    const client = await connect(aliceToken);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TABDUMP_MCP_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
    await client.close();
  });

  it("offers the workspace resource template and lists only the caller's workspaces as resources", async () => {
    const client = await connect(aliceToken);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "tabdump://workspace/{workspaceId}",
    ]);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      [`tabdump://workspace/${ALICE_RESEARCH}`, `tabdump://workspace/${ALICE_OTHER}`].sort()
    );
    await client.close();
  });

  it("reads a workspace resource", async () => {
    const client = await connect(aliceToken);
    const read = await client.readResource({ uri: `tabdump://workspace/${ALICE_RESEARCH}` });
    const body = JSON.parse((read.contents[0] as { text: string }).text);
    expect(body.items.some((item: { sourceId: string }) => item.sourceId === TAB_DOCS)).toBe(true);
    await client.close();
  });
});

describe("workspace tools", () => {
  it("lists the caller's workspaces and nobody else's", async () => {
    const client = await connect(aliceToken);
    const { json } = await call(client, "list_workspaces");
    expect(json.workspaces.map((w: { workspaceId: string }) => w.workspaceId).sort()).toEqual(
      [ALICE_RESEARCH, ALICE_OTHER].sort()
    );
    expect(JSON.stringify(json)).not.toContain(BOB_WORKSPACE_NAME);
    await client.close();
  });

  it("returns a workspace overview through the context resolver", async () => {
    const client = await connect(aliceToken);
    const { json } = await call(client, "get_workspace", { workspaceId: ALICE_RESEARCH });

    const types = new Set(json.items.map((item: { sourceType: string }) => item.sourceType));
    expect(types).toEqual(new Set(["workspace", "collection", "tab"]));
    const docs = json.items.find((item: { sourceId: string }) => item.sourceId === TAB_DOCS);
    expect(docs).toMatchObject({ label: "Example Docs — Guide", domain: "docs.example.com" });
    await client.close();
  });

  it("redacts every planted URL secret", async () => {
    const client = await connect(aliceToken);
    const { json, text } = await call(client, "get_workspace", { workspaceId: ALICE_RESEARCH });

    for (const secret of PLANTED_URL_SECRETS) expect(text).not.toContain(secret);
    const callback = json.items.find((item: { sourceId: string }) => item.sourceId === TAB_SECRET_URL);
    expect(callback.urlRedacted).toBe(true);
    expect(callback.url).toContain("api.example.com/callback");
    expect(callback.url).toContain("page=2");
    await client.close();
  });

  it("omits notes unless they are asked for", async () => {
    const client = await connect(aliceToken);
    const without = await call(client, "get_workspace", { workspaceId: ALICE_RESEARCH });
    expect(without.text).not.toContain(PLANTED_NOTE);

    const withNotes = await call(client, "get_tabs", {
      workspaceId: ALICE_RESEARCH,
      tabIds: [TAB_WITH_NOTE],
      includeNotes: true,
    });
    expect(withNotes.json.items[0].note).toBe(PLANTED_NOTE);
    await client.close();
  });

  it("expands a collection into its member tabs", async () => {
    const client = await connect(aliceToken);
    const { json } = await call(client, "get_collection", {
      workspaceId: ALICE_RESEARCH,
      collectionId: COLLECTION_READING,
    });
    const collection = json.items.find((item: { sourceType: string }) => item.sourceType === "collection");
    expect(collection).toMatchObject({ label: "Test Context", memberCount: 2 });
    const tabIds = json.items
      .filter((item: { sourceType: string }) => item.sourceType === "tab")
      .map((item: { sourceId: string }) => item.sourceId)
      .sort();
    expect(tabIds).toEqual([TAB_DOCS, TAB_SECRET_URL].sort());
    await client.close();
  });

  it("returns a tab's relationships", async () => {
    const client = await connect(aliceToken);
    const { json } = await call(client, "get_tab_graph", { workspaceId: ALICE_RESEARCH, tabId: TAB_DOCS });
    const relationship = json.items.find((item: { sourceType: string }) => item.sourceType === "relationship");
    expect(relationship).toMatchObject({ fromTabId: TAB_DOCS, toTabId: TAB_SECRET_URL, kind: "reference" });
    await client.close();
  });

  it("never echoes the internal owner id", async () => {
    const client = await connect(aliceToken);
    const { text } = await call(client, "get_workspace", { workspaceId: ALICE_RESEARCH });
    expect(text).not.toContain("account:");
    expect(text).not.toContain(ALICE);
    await client.close();
  });
});

describe("account isolation", () => {
  it("answers another account's workspace exactly as it answers a nonexistent one", async () => {
    const client = await connect(aliceToken);
    const bobs = await call(client, "get_workspace", { workspaceId: BOB_PRIVATE });
    const nothing = await call(client, "get_workspace", { workspaceId: "ffffffff-0000-4000-8000-000000000000" });

    expect(bobs.isError).toBe(true);
    expect(bobs.text).toBe(nothing.text);
    expect(bobs.text).not.toContain(BOB_WORKSPACE_NAME);
    await client.close();
  });

  it("cannot pull another account's tab into its own workspace by id", async () => {
    const client = await connect(aliceToken);
    const { json, text } = await call(client, "get_tabs", { workspaceId: ALICE_RESEARCH, tabIds: [BOB_TAB] });
    expect(json.items).toEqual([]);
    expect(text).not.toContain(BOB_TAB_TITLE);
    await client.close();
  });

  it("serves each token its own account", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);

    const aliceSees = (await call(alice, "list_workspaces")).json.workspaces.map((w: { workspaceId: string }) => w.workspaceId);
    const bobSees = (await call(bob, "list_workspaces")).json.workspaces.map((w: { workspaceId: string }) => w.workspaceId);

    expect(bobSees).toEqual([BOB_PRIVATE]);
    expect(aliceSees).not.toContain(BOB_PRIVATE);
    expect((await call(bob, "get_workspace", { workspaceId: BOB_PRIVATE })).text).toContain(BOB_TAB_TITLE);
    await alice.close();
    await bob.close();
  });

  it("lists only the caller's agent projects and sessions, without sandbox handles", async () => {
    const client = await connect(aliceToken);
    const projects = await call(client, "list_agent_projects");
    const sessions = await call(client, "list_agent_sessions");

    expect(projects.json.projects.map((p: { id: string }) => p.id)).toEqual(["rp-alice"]);
    expect(sessions.json.sessions).toEqual([
      expect.objectContaining({ id: "rs-alice", projectId: "rp-alice", resumable: true }),
    ]);
    for (const text of [projects.text, sessions.text]) {
      expect(text).not.toContain("PLANTED");
      expect(text).not.toContain("sandbox");
      expect(text).not.toContain("rp-bob");
    }
    await client.close();
  });
});

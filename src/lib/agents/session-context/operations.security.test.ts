// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSessionContextServer } from "./http";
import { createSessionContextRegistry } from "./registry";

/**
 * The guards J.5 adds, pinned (Phase J.5).
 *
 * An agent reaches the workspace through data — three kinds of operation — and
 * never through code. These tests hold that structurally: what the plan
 * modules may import, what the Command Centre may call when it applies a plan,
 * and what an agent can put in a tool call at all.
 */

const SRC = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");
/** Source without comments, so a guard reads what runs, not what is said about it. */
const code = (relative: string) => read(relative).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PURE = ["lib/agents/session-context/plan.ts", "lib/agents/session-context/insight.ts", "lib/collections/batch.ts"];

describe("the operation model is data, not code", () => {
  it("keeps the plan, insight and batch modules pure: no filesystem, process, network, storage or evaluation", () => {
    for (const file of PURE) {
      const source = code(file);
      expect(source, file).not.toMatch(/from "node:|from "(fs|child_process|path|os|net|http)"|require\(/);
      expect(source, file).not.toMatch(/\bfetch\(|localStorage|indexedDB|sessionStorage|\beval\(|new Function\(|process\./);
    }
  });

  it("lets a batch reach only the three collection reducers an agent may propose — never delete or remove", () => {
    const batch = code("lib/collections/batch.ts");
    const imported = /import \{([^}]*)\} from "\.\/relations"/.exec(batch)?.[1].split(",").map((name) => name.trim()).filter(Boolean);
    expect(imported?.sort()).toEqual(["addTabsToCollection", "createCollection", "renameCollection"]);
    expect(batch).not.toMatch(/delete|remove/i);
  });

  it("applies an approved plan only through the store's batch, and nothing else in the store", () => {
    const hook = code("hooks/use-session-context.ts");
    const applyPlan = hook.slice(hook.indexOf("function applyPlan"));
    expect(applyPlan).toContain("applyCollectionBatch(workspaceId, action.operations)");
    expect(hook).not.toMatch(/setCollections|localStorage|indexedDB|deleteCollection|removeTab/);
    // The plan names no method: its operations are matched by kind inside the batch, never looked up by name.
    expect(code("lib/collections/batch.ts")).not.toMatch(/\[operation\.kind\]|\[kind\]\(/);
  });
});

describe("what an agent can send", () => {
  it("offers no tool argument that could carry code, a path, a command, SQL or a URL to fetch", async () => {
    const registry = createSessionContextRegistry({});
    const server = createSessionContextServer({ registry });
    const bound = await registry.bind({
      sessionId: "s1",
      ownerId: "local",
      workspaceId: "ws",
      access: "read_write",
      snapshot: { workspace: { id: "ws", name: "W", createdAt: 1, updatedAt: 1, tabs: [] }, collections: [], dependencies: [] },
    });
    const client = new Client({ name: "probe", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(await server.url()), { requestInit: { headers: { Authorization: `Bearer ${bound!.token}` } } })
    );
    const { tools } = await client.listTools();

    const names = new Set<string>();
    const collect = (schema: unknown): void => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as Record<string, unknown>;
      if (node.properties && typeof node.properties === "object") {
        for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) {
          names.add(name);
          collect(child);
        }
      }
      for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else collect(value);
      }
    };
    for (const tool of tools) collect(tool.inputSchema);

    // Every argument any session tool takes, pinned. A new one is a deliberate edit here.
    expect([...names].sort()).toEqual(
      [
        "basedOnVersion",
        "collectionId",
        "confidence",
        "depth",
        "includeNotes",
        "kind",
        "knownVersion",
        "limit",
        "maxResults",
        "maxTabs",
        "name",
        "offset",
        "operations",
        "query",
        "reason",
        "sinceVersion",
        "tabId",
        "tabIds",
        "uncategorizedOnly",
        "workspaceId",
      ].sort()
    );
    for (const name of names) expect(name).not.toMatch(/script|code|path|file|command|shell|sql|url|exec|method|store|storage|eval/i);

    // And the only operation kinds a plan accepts are the three J.4 changes.
    const propose = tools.find((tool) => tool.name === "propose_workspace_plan");
    expect(JSON.stringify(propose?.inputSchema).match(/"const":"([a-z_]+)"/g)?.sort()).toEqual(
      ['"const":"add_tabs_to_collection"', '"const":"create_collection"', '"const":"rename_collection"'].sort()
    );
    await client.close();
    await server.close();
  });
});

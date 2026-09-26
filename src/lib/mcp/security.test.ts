// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHubbleMcpServer, TABDUMP_MCP_TOOLS } from "./server";
import { createFixtureData, ALICE } from "./__fixtures__/accounts";

/**
 * The MCP layer cannot escape Hubble's existing boundaries.
 *
 * Structural assertions, in the style of the control plane's and the remote
 * plane's guard suites: what the code *can* reach, not only what today's
 * tools happen to do.
 */

const DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(DIR, "../../..");

function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const MODULES = readdirSync(DIR)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, code: codeOf(readFileSync(path.join(DIR, file), "utf8")) }));

const ROUTES = ["src/app/api/mcp/route.ts", "src/app/api/mcp/tokens/route.ts"].map((file) => ({
  file,
  code: codeOf(readFileSync(path.join(REPO_ROOT, file), "utf8")),
}));

function importsOf(code: string): string[] {
  return [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

describe("the MCP layer is not a second control plane", () => {
  const FORBIDDEN_IMPORTS = [
    /^@\/lib\/agents\/control\//,
    /^@\/lib\/agents\/runtime\//,
    /^@\/lib\/agents\/credentials\//,
    /^@\/lib\/agents\/remote\/(sandbox|sandbox-vercel|bridge|services|projects|upload|platform-identity)$/,
    /^@anthropic-ai\//,
    /^@vercel\/sandbox/,
    /^node:child_process$/,
    /^child_process$/,
    /^node:fs/,
    /^fs$/,
  ];

  for (const { file, code } of [...MODULES, ...ROUTES]) {
    it(`${file} imports nothing that can execute, steer an agent or read a credential`, () => {
      for (const specifier of importsOf(code)) {
        for (const pattern of FORBIDDEN_IMPORTS) {
          expect(pattern.test(specifier), `${file} imports ${specifier}`).toBe(false);
        }
      }
    });
  }

  it("reads the remote agent plane through its store's types only", () => {
    // Status is read from the owner-scoped store; nothing that dispatches.
    const data = MODULES.find((m) => m.file === "data.ts")!;
    const remoteImports = importsOf(data.code).filter((s) => s.startsWith("@/lib/agents/remote/"));
    expect(remoteImports).toEqual(["@/lib/agents/remote/store"]);
    expect(data.code).toMatch(/import type \{ RemoteStore \} from "@\/lib\/agents\/remote\/store"/);
  });

  it("builds workspace answers through the Phase E context resolver", () => {
    const server = MODULES.find((m) => m.file === "server.ts")!;
    expect(server.code).toContain('from "@/lib/agents/context/resolve"');
    expect(server.code).toContain("resolveContext(");
    // And withholds project roots, as a hosted deployment must.
    expect(server.code).toContain("localRuntimeAllowed: false");
  });
});

describe("the tool vocabulary", () => {
  it("is exactly the pinned list", () => {
    expect([...TABDUMP_MCP_TOOLS]).toEqual([
      "list_workspaces",
      "get_workspace",
      "get_tabs",
      "get_collection",
      "get_tab_graph",
      "list_agent_projects",
      "list_agent_sessions",
    ]);
  });

  it("contains no verb that writes, executes or controls", () => {
    const WRITE_VERBS =
      /(^|_)(create|update|delete|remove|write|edit|set|add|move|rename|run|exec|execute|spawn|start|stop|cancel|send|message|approve|deny|respond|upload|download|fetch|open|connect|authorize|install)(_|$)/;
    for (const name of TABDUMP_MCP_TOOLS) expect(WRITE_VERBS.test(name), name).toBe(false);
  });

  it("accepts no argument that could name a path, a command, a URL or an owner", async () => {
    const server = createHubbleMcpServer({ data: await createFixtureData(), userId: ALICE });
    // The registered tools, as the SDK holds them.
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })
      ._registeredTools;

    const FORBIDDEN_ARGS = /^(path|paths|file|files|dir|directory|cwd|root|command|cmd|args|shell|script|url|uri|href|endpoint|owner|ownerId|user|userId|account|accountId|token|secret|sandbox|sandboxName|env)$/i;

    expect(Object.keys(registered).sort()).toEqual([...TABDUMP_MCP_TOOLS].sort());
    const seen = new Set<string>();
    for (const [name, tool] of Object.entries(registered)) {
      const shape = tool.inputSchema?.shape ?? {};
      for (const arg of Object.keys(shape)) {
        seen.add(arg);
        expect(FORBIDDEN_ARGS.test(arg), `${name}(${arg})`).toBe(false);
      }
    }
    // Not vacuous: the schemas were really inspected, and this is their whole vocabulary.
    expect([...seen].sort()).toEqual(
      ["collectionId", "depth", "includeNotes", "maxTabs", "tabId", "tabIds", "workspaceId"].sort()
    );
  });
});

describe("authentication stays on its own path", () => {
  it("the MCP endpoint never reads a session cookie", () => {
    for (const { file, code } of [
      ...MODULES.filter((m) => ["http.ts", "server.ts", "data.ts", "services.ts"].includes(m.file)),
      ROUTES[0],
    ]) {
      expect(code, file).not.toContain("getSession");
      expect(code, file).not.toContain("readSessionToken");
      expect(code, file).not.toMatch(/cookie/i);
    }
  });

  it("the token routes are the only place a session is consulted, and they mint no anonymous actor", () => {
    const tokensRoute = ROUTES[1].code;
    expect(tokensRoute).toContain("getSession(request)");
    expect(tokensRoute).not.toContain("LOCAL_ACTOR");
  });

  it("reads no provider credential and no environment variable of its own", () => {
    for (const { file, code } of [...MODULES, ...ROUTES]) {
      expect(code, file).not.toContain("process.env");
      expect(code, file).not.toContain("ANTHROPIC");
    }
  });

  it("stores tokens only as hashes, enforced by the schema", () => {
    const schema = readFileSync(path.join(DIR, "schema.sql"), "utf8");
    expect(schema).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(schema).toContain("scopes <@ ARRAY['read']::TEXT[]");
    // No column could hold the token itself.
    expect(schema).not.toMatch(/^\s+token\s+TEXT/m);
  });
});

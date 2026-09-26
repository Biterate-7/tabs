import { describe, expect, it } from "vitest";
import { authorizeContextRequest, contextToolsFor } from "./authorization";
import { READ_CAPABILITIES, SESSION_CONTEXT_TOOLS, capabilitiesFor } from "./capabilities";
import { CONTEXT_SERVER_NAME_PATTERN, isContextServerName, mintContextServerName } from "./identity";
import type { ContextAuthority, SessionContextRequest } from "./authorization";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The one decision about workspace context (Phase J.4), and the identity it
 * rests on. Every provider is held to the same answers.
 */

const READ_WRITE: ContextAuthority = {
  sessionId: "s1",
  workspaceId: "ws-launch",
  serverName: "tabdump_abcdefghijklmnop",
  capabilities: capabilitiesFor("read_write"),
};
const READ_ONLY: ContextAuthority = { ...READ_WRITE, capabilities: capabilitiesFor("read") };

const PROVIDERS: (AgentProviderId | undefined)[] = ["claude-code", "gemini", "grok", "openai-codex", undefined];
const ORIGINS = ["context-server", "claude-sdk", "acp"] as const;

function ask(over: Partial<SessionContextRequest> = {}, authority: ContextAuthority | null = READ_WRITE) {
  return authorizeContextRequest(
    { sessionId: "s1", origin: "context-server", serverName: READ_WRITE.serverName, ...over },
    authority ?? undefined
  );
}

describe("the context server's identity", () => {
  it("is minted per session in a fixed, unguessable shape", () => {
    let counter = 0;
    // Distinct inputs in, distinct names out: a counter spread over the bytes.
    const bytes = (length: number) => {
      counter += 1;
      return Uint8Array.from({ length }, (_, index) => (counter * (index + 1) * 37) % 256);
    };
    const names = new Set(Array.from({ length: 50 }, () => mintContextServerName(bytes)));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(CONTEXT_SERVER_NAME_PATTERN);
    const real = mintContextServerName((length) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
    expect(isContextServerName(real)).toBe(true);
  });

  it("refuses anything else as a name — including the old fixed one and anything a user could type", () => {
    for (const name of ["tabdump", "tabdump_", "tabdump_ABCDEFGHIJKLMNOP", "tabdump_abcdefghijklmno", "tabdump_abcdefghijklmnop ", "--yolo", "tabdump_abcdefghijklmnop;rm", 42, undefined]) {
      expect(isContextServerName(name)).toBe(false);
    }
  });
});

describe("the one decision", () => {
  it("allows reads with no approval and writes only with an approval every time", () => {
    for (const tool of SESSION_CONTEXT_TOOLS) {
      const decision = ask({ tool });
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) continue;
      const writes = ["create_collection", "rename_collection", "add_tabs_to_collection", "propose_workspace_plan"].includes(tool);
      expect(decision).toMatchObject(writes ? { access: "write", approval: "every-time" } : { access: "read", approval: "none" });
    }
  });

  it("gives a read-only session no write at all", () => {
    for (const tool of ["create_collection", "rename_collection", "add_tabs_to_collection"]) {
      expect(ask({ tool }, READ_ONLY)).toEqual({ allowed: false, reason: "not_permitted" });
    }
    expect(contextToolsFor(READ_CAPABILITIES)).not.toContain("create_collection");
    expect(contextToolsFor(READ_WRITE.capabilities)).toEqual(SESSION_CONTEXT_TOOLS);
  });

  it("refuses another session, another workspace, an unproven or forged server, an unknown tool and no session", () => {
    expect(ask({ sessionId: "s2", tool: "get_tabs" })).toEqual({ allowed: false, reason: "wrong_session" });
    expect(ask({ workspaceId: "ws-private", tool: "get_workspace" })).toEqual({ allowed: false, reason: "wrong_workspace" });
    expect(ask({ serverName: undefined, tool: "get_tabs" })).toEqual({ allowed: false, reason: "unattested" });
    expect(ask({ serverName: "tabdump", tool: "get_tabs" })).toEqual({ allowed: false, reason: "unattested" });
    expect(ask({ serverName: "tabdump_zzzzzzzzzzzzzzzz", tool: "get_tabs" })).toEqual({ allowed: false, reason: "unattested" });
    expect(ask({ tool: "delete_workspace" })).toEqual({ allowed: false, reason: "unknown_tool" });
    expect(ask({ tool: "__proto__" })).toEqual({ allowed: false, reason: "unknown_tool" });
    expect(ask({ tool: "get_tabs" }, null)).toEqual({ allowed: false, reason: "no_session" });
  });

  it("cannot be talked into more by fields a request carries", () => {
    const forged = { tool: "create_collection", capabilities: ["collections.write"], access: "read_write" } as unknown as Partial<SessionContextRequest>;
    expect(ask(forged, READ_ONLY)).toEqual({ allowed: false, reason: "not_permitted" });
  });

  it("lets the server decide the tool when an agent-level request cannot name it — never the server itself", () => {
    expect(ask({ origin: "acp" })).toEqual({ allowed: true, access: "per-tool", approval: "at-server" });
    expect(ask({ origin: "context-server" })).toEqual({ allowed: false, reason: "unknown_tool" });
    expect(ask({ origin: "acp" }, { ...READ_WRITE, capabilities: [] })).toEqual({ allowed: false, reason: "not_permitted" });
  });
});

describe("provider parity", () => {
  it("answers every provider identically, for every tool, origin and authority", () => {
    const cases: Partial<SessionContextRequest>[] = [
      ...SESSION_CONTEXT_TOOLS.map((tool) => ({ tool })),
      { tool: "get_workspace", workspaceId: "ws-private" },
      { tool: "get_tabs", sessionId: "s2" },
      { tool: "get_tabs", serverName: "tabdump" },
      {},
    ];
    for (const authority of [READ_WRITE, READ_ONLY, null]) {
      for (const origin of ORIGINS) {
        for (const request of cases) {
          const answers = PROVIDERS.map((provider) =>
            JSON.stringify(ask({ ...request, origin, ...(provider ? { provider } : {}) }, authority))
          );
          expect(new Set(answers).size, JSON.stringify({ origin, request })).toBe(1);
        }
      }
    }
  });
});

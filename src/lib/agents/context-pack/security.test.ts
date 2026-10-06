import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyContextWorld } from "@/lib/agents/context/world";
import { buildHandoffEnvelope } from "@/lib/agents/handoff/handoff";
import { buildContextPack } from "./pack";
import { contextPackAttachedContext } from "./attach";
import { contextWorldOfSnapshot, handoffContextPack } from "./handoff";
import { contextDeliveryOf, contextProvenanceOf } from "./provenance";
import { buildSessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { ContextPack } from "./pack";

/*
 * The Context Pack carries the user's own resources to an agent — and
 * nothing else. These tests feed it a workspace whose every free-text field
 * holds something that must never leave Hubble, and check that none of it
 * survives into the pack, its attachments, a handoff envelope or provenance.
 */

const T0 = 1_700_000_000_000;

const SECRETS = {
  userinfo: "hunter2userinfo",
  query: "QUERYSECRETVALUE123",
  fragment: "FRAGMENTACCESS456",
  apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwx",
  githubToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  bearer: "abcdefghijklmnopqrstuvwxyz012345",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpM",
  cookie: "sessionCOOKIEVALUE789",
  mcpToken: "tdmcp_abcdefghijklmnopqrstuvwxyz012345",
  contextToken: "tdctx_abcdefghijklmnopqrstuvwxyz012345",
  password: "correcthorsebattery",
  note: "PRIVATENOTETEXT",
} as const;

function hostileWorld(): AgentContextWorld {
  return {
    ...emptyContextWorld("owner-1"),
    workspaces: [
      {
        id: "w1",
        name: `Research ${SECRETS.mcpToken}`,
        tabs: [
          {
            id: "t-bank",
            url: `https://user:${SECRETS.userinfo}@bank.example/reset?token=${SECRETS.query}&page=2#access_token=${SECRETS.fragment}`,
            normalizedUrl: "https://bank.example/reset",
            domain: "bank.example",
            title: `My key ${SECRETS.apiKey}`,
            notes: SECRETS.note,
          },
          {
            id: "t-jwt",
            url: `https://app.example/callback/${SECRETS.jwt}`,
            normalizedUrl: "https://app.example/callback",
            domain: "app.example",
            title: `Authorization: Bearer ${SECRETS.bearer}`,
          },
        ],
        brief: {
          description: `Deploy with cookie: ${SECRETS.cookie} and ${SECRETS.githubToken}`,
          focus: `password=${SECRETS.password} ${SECRETS.contextToken}`,
          updatedAt: T0,
        },
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    collections: [{ id: "c1", workspaceId: "w1", name: `Keys ${SECRETS.githubToken}`, tabIds: ["t-bank", "t-jwt"], createdAt: T0, updatedAt: T0 }],
    dependencies: [{ id: "d1", parentTabId: "t-bank", childTabId: "t-jwt", createdAt: T0 }],
  };
}

function hostilePack(): ContextPack {
  const result = buildContextPack({
    world: hostileWorld(),
    selection: { workspaceId: "w1", tabIds: ["t-bank", "t-jwt"], collectionIds: ["c1"] },
    instruction: `Use api_key=${SECRETS.query} and Bearer ${SECRETS.bearer}`,
    previousResult: { outcome: "finished", lines: [{ title: "Created plan.md" }], more: 0, files: [{ path: "plan.md", change: "created" }] },
    files: [{ path: `secrets/${SECRETS.githubToken}.txt`, change: "created" }],
  });
  if (!result.ok) throw new Error(result.reason);
  return result.pack;
}

const expectClean = (text: string) => {
  for (const [name, secret] of Object.entries(SECRETS)) expect(text, name).not.toContain(secret);
};

describe("a Context Pack never carries a secret", () => {
  it("excludes credentials, tokens, headers, cookies, userinfo, secret query values and fragments", () => {
    const pack = hostilePack();
    expectClean(JSON.stringify(pack));
    // Still useful: the resources are there, named, with their redacted addresses.
    expect(pack.tabs).toHaveLength(2);
    expect(pack.tabs.find((tab) => tab.id === "t-bank")!.url).toBe("https://bank.example/reset?token=%5Bredacted%5D&page=2");
    expect(pack.collections).toHaveLength(1);
  });

  it("excludes them from what the runtime is sent, too", () => {
    const attached = contextPackAttachedContext(hostilePack(), T0)!;
    expect(attached.attachments.length).toBeGreaterThan(0);
    expectClean(JSON.stringify(attached));
  });

  it("never includes the user's notes", () => {
    expect(JSON.stringify(hostilePack())).not.toContain(SECRETS.note);
  });

  it("drops a file path that is itself a credential rather than passing it on", () => {
    expect(hostilePack().files).toEqual([]);
  });

  it("holds only the pack's own fields — no transcript, reasoning, protocol payload, runtime address or credential field", () => {
    const pack = hostilePack();
    expect(Object.keys(pack).sort()).toEqual(
      ["collections", "files", "fingerprint", "instruction", "omitted", "previousResult", "recentChanges", "relationships", "scope", "sources", "tabs", "version", "workspace"].sort()
    );
    const text = JSON.stringify(pack).toLowerCase();
    for (const forbidden of ["transcript", "reasoning", "thinking", "payload", "http://127.0.0.1", "localhost", "/mcp", "credential", "\"token\""]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe("a handoff passes the pack without leaking", () => {
  it("builds the envelope and attachments from the scrubbed pack — never a transcript or reasoning", () => {
    const world = hostileWorld();
    const snapshot = buildSessionContextSnapshot(world, "w1")!;
    const context = {
      workspace: { tabs: 2, collections: 1, focus: { tabs: 2, collections: 1, collectionIds: ["c1"] } },
      previousResult: { outcome: "finished" as const, lines: [{ title: "Created plan.md" }], more: 0 },
    };
    const pack = handoffContextPack({
      world: contextWorldOfSnapshot(snapshot),
      workspaceId: "w1",
      focus: { tabIds: ["t-bank", "t-jwt"], collectionIds: ["c1"] },
      context,
      instruction: `Continue. password=${SECRETS.password}`,
    })!;
    const envelope = buildHandoffEnvelope({
      workspaceName: snapshot.workspace.name,
      sourceProvider: "claude-code",
      context,
      contextTools: true,
      pack,
    });
    expectClean(envelope);
    expectClean(JSON.stringify(contextPackAttachedContext(pack, T0)));
    expect(envelope).toContain("Selected:");
    expect(envelope).not.toMatch(/thinking|reasoning|transcript/i);
  });
});

describe("provenance is resources, never content", () => {
  it("records counts and ids only, and reads back as names", () => {
    const attached = contextPackAttachedContext(hostilePack(), T0)!;
    const delivery = contextDeliveryOf(attached, "w1")!;
    expect(Object.keys(delivery).sort()).toEqual(["collectionIds", "collections", "contextId", "relationships", "tabs", "workspace", "workspaceId"]);
    expectClean(JSON.stringify(delivery));
    const provenance = contextProvenanceOf({
      session: { sessionId: "s1", workspaceId: "w1" },
      events: [{ kind: "message_sent", sessionId: "s1", timestamp: T0, delivery }],
      at: T0 + 1,
      workspaceName: "Research",
      collectionName: () => "Keys",
      agentName: () => "Claude Code",
    })!;
    expect(provenance.lines).toEqual(["Research workspace · Workspace brief", "Keys collection · 2 tabs"]);
  });
});

describe("the context-pack module stays on Hubble's side", () => {
  const dir = path.join(process.cwd(), "src/lib/agents/context-pack");
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, code: readFileSync(path.join(dir, name), "utf8") }));

  it("imports no runtime host, server, MCP server, credential store, adapter or storage", () => {
    expect(sources.length).toBeGreaterThan(4);
    for (const { name, code } of sources) {
      expect(code, name).not.toMatch(/from "@\/lib\/agents\/runtime\/(host|server|desktop)"/);
      expect(code, name).not.toMatch(/from "@\/lib\/mcp\//);
      expect(code, name).not.toMatch(/from "@\/lib\/agents\/credentials/);
      expect(code, name).not.toMatch(/from "@\/lib\/agents\/control\/providers/);
      expect(code, name).not.toMatch(/from "@\/lib\/(storage|sync)\//);
      expect(code, name).not.toMatch(/localStorage|fetch\(|process\.env/);
    }
  });
});

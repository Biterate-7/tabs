import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { createSessionContextServer } from "../http";
import { createSessionContextRegistry } from "../registry";
import { STUDENT_TABS } from "./reasoning";
import type { ApprovalOutcome, ContextApprovalRequest, SessionContextRegistry } from "../registry";
import type { SessionContextServer } from "../http";

/**
 * The real loopback server, session MCP server, registry and official MCP
 * client, with the two human-side roles played by the test: the user who
 * answers approvals (`answer`) and the Command Centre that applies an
 * approved plan with the store's own batch and syncs it (`applyApproved`).
 * Shared by the J.6 hardening tests.
 */

export const STUDENT = {
  workspace: { id: "ws-student", name: "Senior year", createdAt: 1, updatedAt: 2, tabs: STUDENT_TABS },
  collections: [{ id: "col-physics", workspaceId: "ws-student", name: "Physics", tabIds: ["p1", "p2"], createdAt: 1, updatedAt: 1 }],
  dependencies: [{ id: "dep1", parentTabId: "p2", childTabId: "p4", createdAt: 1 }],
};

export type RawSnapshot = {
  workspace: { id: string; name: string; createdAt: number; updatedAt: number; tabs: readonly unknown[] };
  collections: readonly unknown[];
  dependencies: readonly unknown[];
};

export type Harness = {
  registry: SessionContextRegistry;
  server: SessionContextServer;
  /** Every approval the user was asked for, in order. */
  asked: ContextApprovalRequest[];
  /** The user answers the oldest open approval. */
  answer: (outcome: ApprovalOutcome) => void;
  clock: { now: number };
};

const open: SessionContextServer[] = [];

/** For afterEach. */
export async function closeServers(): Promise<void> {
  for (const server of open.splice(0)) await server.close();
}

export function harness(): Harness {
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

export async function connect(h: Harness, token: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(await h.server.url()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  );
  return client;
}

/** Session "s1" on `snapshot`, plus a second session on another workspace that must never be visible. */
export async function bind(h: Harness, options: { access?: "read" | "read_write"; snapshot?: RawSnapshot } = {}): Promise<Client> {
  const snapshot = options.snapshot ?? STUDENT;
  const bound = await h.registry.bind({
    sessionId: "s1",
    ownerId: "local",
    workspaceId: snapshot.workspace.id,
    access: options.access ?? "read_write",
    snapshot,
  });
  await h.registry.bind({
    sessionId: "s2",
    ownerId: "local",
    workspaceId: "ws-private",
    access: "read_write",
    snapshot: {
      workspace: { id: "ws-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [{ id: "t-bank", url: "https://bank.example.com/x", normalizedUrl: "https://bank.example.com/x", domain: "bank.example.com", title: "Bank statement" }] },
      collections: [],
      dependencies: [],
    },
  });
  return connect(h, bound!.token);
}

export type Called = { isError: boolean; text: string; json: () => ReturnType<typeof JSON.parse> };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

export async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The collections the session holds, as plain data, for before/after comparison. */
export function heldCollections(h: Harness, sessionId = "s1") {
  return JSON.parse(JSON.stringify(h.registry.binding(sessionId)!.snapshot.collections));
}

/** Nothing asked, nothing waiting to be applied, the version where it was. */
export function expectUntouched(h: Harness, version = 1): void {
  expect(h.asked).toEqual([]);
  expect(h.registry.pendingApplications("s1")).toEqual([]);
  expect(h.registry.binding("s1")!.version).toBe(version);
}

/** The Command Centre's part, as J.5 does it: apply the approved plan with the store's batch, sync, report. Returns the applied collections. */
export function applyApproved(h: Harness, sessionId = "s1") {
  const pending = h.registry.pendingApplications(sessionId);
  expect(pending).toHaveLength(1);
  const [action] = pending;
  const held = h.registry.binding(sessionId)!.snapshot;
  const applied = applyCollectionBatch(
    held.collections,
    { workspaceId: held.workspace.id, tabIds: new Set(held.workspace.tabs.map((entry) => entry.id)) },
    action.plan!.operations,
    9
  );
  if (!applied.ok) throw new Error(`apply failed at ${applied.failedAt}`);
  h.registry.update(sessionId, { ...held, collections: applied.collections });
  expect(h.registry.complete(sessionId, action.id, { ok: true, planHash: action.plan!.hash, created: applied.created })).toBe(true);
  return applied.collections;
}

/**
 * The approval boundary, observed from both sides: an agent proposes `plan`;
 * until the user answers, nothing is applied, nothing is pending and the
 * version has not moved; the user approves; the Command Centre applies it
 * once; the version moves exactly once; the agent is told applied + verified.
 */
export async function proposeApproveApply(h: Harness, client: Client, plan: { basedOnVersion: number; operations: unknown[] }) {
  const version = h.registry.binding("s1")!.version;
  const before = heldCollections(h);
  const askedBefore = h.asked.length;
  const proposal = call(client, "propose_workspace_plan", plan);

  await until(() => h.asked.length === askedBefore + 1);
  const approval = h.asked.at(-1)!;
  // Proposed, not approved, not executed.
  expect(approval.plan).toBeDefined();
  expect(h.registry.pendingApplications("s1")).toEqual([]);
  expect(h.registry.binding("s1")!.version).toBe(version);
  expect(heldCollections(h)).toEqual(before);

  h.answer("granted");
  await until(() => h.registry.pendingApplications("s1").length === 1);
  // Approved, still not executed: the Command Centre has not applied it.
  expect(h.registry.binding("s1")!.version).toBe(version);
  expect(heldCollections(h)).toEqual(before);

  applyApproved(h);
  const result = (await proposal).json();
  expect(result).toMatchObject({ applied: true, verified: true, previousVersion: version, contextVersion: version + 1 });
  // Exactly one approval, exactly one execution, exactly one version step.
  expect(h.asked.length).toBe(askedBefore + 1);
  expect(h.registry.pendingApplications("s1")).toEqual([]);
  expect(h.registry.binding("s1")!.version).toBe(version + 1);
  return { approval, result };
}

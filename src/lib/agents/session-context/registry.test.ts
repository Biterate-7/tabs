import { describe, expect, it } from "vitest";
import { CONTEXT_SERVER_NAME_PATTERN } from "./identity";
import { CREDENTIAL_MAX_AGE_MS, MAX_CHANGE_IDS, createSessionContextRegistry } from "./registry";
import { SNAPSHOT_LIMITS, snapshotFingerprint, readSessionContextSnapshot } from "./snapshot";
import type { ContextApprovalRequest, ApprovalOutcome } from "./registry";

/**
 * The registry's J.4 additions: per-session server identity, versions and
 * bounded change lists, and the three proposed changes — validated against
 * the bound workspace, described without ids, approved every time, applied
 * at most once.
 */

function tab(id: string, title = id) {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title };
}

function snapshot(tabs = [tab("t1", "Pricing"), tab("t2", "Press kit"), tab("t3", "Brief")], collections = [
  { id: "c1", workspaceId: "ws", name: "Sources", tabIds: ["t1"], createdAt: 1, updatedAt: 1 },
]) {
  return { workspace: { id: "ws", name: "Launch Plan", createdAt: 1, updatedAt: 2, tabs }, collections, dependencies: [] };
}

function harness(answer: ApprovalOutcome = "granted") {
  let clock = 1_000;
  const asked: ContextApprovalRequest[] = [];
  const registry = createSessionContextRegistry({
    now: () => clock,
    approve: async (request) => {
      asked.push(request);
      return answer;
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { registry, asked, advance: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("identity and binding", () => {
  it("gives every session its own server name and credential, and binds a session once", async () => {
    const { registry } = harness();
    const a = await registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot() });
    const b = await registry.bind({ sessionId: "b", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot() });
    expect(a?.serverName).toMatch(CONTEXT_SERVER_NAME_PATTERN);
    expect(b?.serverName).not.toBe(a?.serverName);
    expect(b?.token).not.toBe(a?.token);
    expect(registry.authority("a")).toEqual({ sessionId: "a", workspaceId: "ws", serverName: a?.serverName, capabilities: expect.any(Array) });
    // A duplicate bind is refused and leaves the first intact.
    expect(await registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read_write", snapshot: snapshot() })).toBeUndefined();
    expect(registry.binding("a")?.access).toBe("read");
    expect((await registry.authenticate(a!.token))?.sessionId).toBe("a");
    expect((await registry.authenticate(b!.token))?.sessionId).toBe("b");
  });

  it("forgets a credential at its ceiling and on release; nothing revives it", async () => {
    const { registry, advance } = harness();
    const a = await registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot() });
    advance(CREDENTIAL_MAX_AGE_MS);
    expect(await registry.authenticate(a!.token)).toBeUndefined();
    expect(registry.activeCount()).toBe(0);
    registry.release("a");
    expect(registry.authority("a")).toBeUndefined();
    expect(await registry.authenticate(a!.token)).toBeUndefined();
  });
});

describe("versions", () => {
  it("is monotonic, moves only on change, and matches the fingerprint the webview computes", async () => {
    const { registry } = harness();
    await registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot() });
    const held = registry.binding("a")!;
    expect(held.version).toBe(1);
    expect(held.fingerprint).toBe(snapshotFingerprint(readSessionContextSnapshot(snapshot(), "ws")!));

    expect(registry.update("a", snapshot())).toEqual({ version: 1, changed: false });
    expect(registry.update("a", snapshot([tab("t1", "Pricing v2"), tab("t2", "Press kit")]))).toEqual({ version: 2, changed: true });
    expect(registry.changesSince("a", 1)).toMatchObject({
      version: 2,
      complete: true,
      tabs: { changed: ["t1"], removed: ["t3"] },
      collections: { changed: [], removed: [] },
      truncated: false,
    });
    expect(registry.changesSince("a", 2)).toMatchObject({ tabs: { changed: [], removed: [] } });
    // A snapshot of another workspace changes nothing, including the version.
    expect(registry.update("a", { ...snapshot(), workspace: { ...snapshot().workspace, id: "other" } })).toBeUndefined();
    expect(registry.binding("a")?.version).toBe(2);
  });

  it("keeps change lists bounded and says when an old version can no longer be answered", async () => {
    const { registry } = harness();
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => tab(`${prefix}${index}`));
    await registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot(many("a", 150), []) });

    registry.update("a", snapshot(many("b", 150), []));
    const changes = registry.changesSince("a", 1)!;
    expect(changes.tabs.changed).toHaveLength(MAX_CHANGE_IDS);
    expect(changes.tabs.removed).toHaveLength(MAX_CHANGE_IDS);
    expect(changes.truncated).toBe(true);

    // Enough whole-workspace turnovers to exceed what the registry remembers.
    for (let round = 0; round < 4; round += 1) registry.update("a", snapshot(many(`r${round}-`, SNAPSHOT_LIMITS.tabs), []));
    expect(registry.changesSince("a", 1)?.complete).toBe(false);
    expect(registry.changesSince("a", registry.binding("a")!.version - 1)?.complete).toBe(true);
  });
});

describe("proposed changes", () => {
  async function bound(answer: ApprovalOutcome = "granted") {
    const h = harness(answer);
    await h.registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read_write", snapshot: snapshot() });
    return h;
  }

  it("refuses without asking anyone: foreign tabs or collections, empty names, changes that change nothing", async () => {
    const { registry, asked } = await bound();
    const refused = [
      { kind: "create_collection", name: "x", tabIds: ["t1", "other-workspace-tab"] },
      { kind: "create_collection", name: "   ", tabIds: ["t1"] },
      { kind: "create_collection", name: "x", tabIds: [] },
      { kind: "rename_collection", collectionId: "c-other", name: "New" },
      { kind: "rename_collection", collectionId: "c1", name: "Sources" },
      { kind: "rename_collection", collectionId: "c1", name: "\u0000\u0007" },
      { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t1"] },
      { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t2", "elsewhere"] },
      { kind: "add_tabs_to_collection", collectionId: "c-other", tabIds: ["t2"] },
    ] as const;
    for (const change of refused) {
      expect(await registry.requestChange("a", change), JSON.stringify(change)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(asked).toEqual([]);
  });

  it("does not let a read-only session propose anything", async () => {
    const { registry, asked } = harness();
    await registry.bind({ sessionId: "r", ownerId: "o", workspaceId: "ws", access: "read", snapshot: snapshot() });
    expect(await registry.requestChange("r", { kind: "rename_collection", collectionId: "c1", name: "New" })).toEqual({ ok: false, reason: "not_permitted" });
    expect(asked).toEqual([]);
  });

  it("describes each change by names and titles — never an id", async () => {
    const { registry, asked } = await bound("denied");
    await registry.requestChange("a", { kind: "create_collection", name: "Launch reading", tabIds: ["t1", "t2"] });
    await registry.requestChange("a", { kind: "rename_collection", collectionId: "c1", name: "Primary sources" });
    await registry.requestChange("a", { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t2", "t3"] });
    expect(asked.map((request) => request.change)).toEqual([
      { kind: "create_collection", subject: "Launch reading", tabCount: 2, details: ["2 tabs", "Moves tabs out of: Sources", "Tab: Pricing", "Tab: Press kit"] },
      { kind: "rename_collection", subject: "Sources", to: "Primary sources", details: ["1 tab in it, unchanged"] },
      { kind: "add_tabs_to_collection", subject: "Sources", tabCount: 2, details: ["Adds 2 tabs", "Tab: Press kit", "Tab: Brief"] },
    ]);
    const shown = JSON.stringify(asked.map(({ change, targets, reason }) => ({ change, targets, reason })));
    expect(shown).not.toMatch(/\bt[123]\b|\bc1\b|"ws"/);
  });

  it("applies nothing when declined, and completes an approved change once, for its own session only", async () => {
    const declined = await bound("denied");
    expect(await declined.registry.requestChange("a", { kind: "rename_collection", collectionId: "c1", name: "New" })).toEqual({ ok: false, reason: "denied" });
    expect(declined.registry.pendingApplications("a")).toEqual([]);

    const { registry } = await bound("granted");
    await registry.bind({ sessionId: "b", ownerId: "o", workspaceId: "ws", access: "read_write", snapshot: snapshot() });
    const result = registry.requestChange("a", { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t2"] });
    await flush();
    const [action] = registry.pendingApplications("a");
    expect(action.change).toEqual({ kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t2"] });
    expect(registry.pendingApplications("b")).toEqual([]);
    expect(registry.complete("b", action.id, { ok: true, collectionId: "c1" })).toBe(false);
    expect(registry.complete("a", action.id, { ok: true, collectionId: "c1" })).toBe(true);
    expect(registry.complete("a", action.id, { ok: true, collectionId: "c1" })).toBe(false);
    expect(await result).toEqual({ ok: true, kind: "add_tabs_to_collection", collectionId: "c1", name: "Sources", tabCount: 1 });
  });

  it("answers a waiting change as ended when the session is released", async () => {
    const h = harness();
    let release: (outcome: ApprovalOutcome) => void = () => {};
    h.registry.setApprover(() => new Promise((resolve) => (release = resolve)));
    await h.registry.bind({ sessionId: "a", ownerId: "o", workspaceId: "ws", access: "read_write", snapshot: snapshot() });
    const result = h.registry.requestChange("a", { kind: "rename_collection", collectionId: "c1", name: "New" });
    h.registry.release("a");
    release("granted");
    expect(await result).toEqual({ ok: false, reason: "ended" });
    expect(h.registry.pendingApplications("a")).toEqual([]);
  });
});

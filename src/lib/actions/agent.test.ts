import { afterEach, describe, expect, it, vi } from "vitest";

const generateAgentTurnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/gemini/client", () => ({ generateAgentTurn: generateAgentTurnMock }));

const { runAgentLoop } = await import("./agent");
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

function baseParams(store: WorkspaceStore) {
  return {
    model: "gemini-3.6-flash",
    systemInstruction: "system",
    contents: [{ role: "user" as const, parts: [{ text: "hi" }] }],
    store,
    maxOutputTokens: 100,
  };
}

afterEach(() => {
  generateAgentTurnMock.mockReset();
});

describe("runAgentLoop", () => {
  it("returns the model's text directly when it never calls a tool", async () => {
    generateAgentTurnMock.mockResolvedValueOnce({ ok: true, data: { text: "Just an answer.", functionCalls: [] } });
    const store = makeStore([makeWorkspace({ id: "a" })], "a");

    const result = await runAgentLoop(baseParams(store));

    expect(result).toEqual({ ok: true, kind: "resolved", text: "Just an answer.", store, storeChanged: false, actions: [] });
    expect(generateAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it("selects list_workspaces, feeds the result back, and returns the model's follow-up text", async () => {
    const store = makeStore([makeWorkspace({ id: "a", name: "Physics" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "list_workspaces", args: {} }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "You have one workspace: Physics.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result).toEqual({
      ok: true,
      kind: "resolved",
      text: "You have one workspace: Physics.",
      store,
      storeChanged: false,
      actions: [{ name: "list_workspaces", ok: true, message: expect.stringContaining("Physics") }],
    });

    const secondCallContents = generateAgentTurnMock.mock.calls[1][0].contents;
    const functionTurn = secondCallContents.find((c: { role: string }) => c.role === "function");
    expect(functionTurn.parts[0].functionResponse.name).toBe("list_workspaces");
    expect(functionTurn.parts[0].functionResponse.response.result.workspaces).toHaveLength(1);
  });

  it("dispatches multiple tool calls issued in a single turn and reports both results back", async () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", name: "A" }), makeWorkspace({ id: "b", name: "B" })],
      "a"
    );
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          text: "",
          functionCalls: [
            { name: "get_workspace", args: { workspaceId: "a" } },
            { name: "get_workspace", args: { workspaceId: "b" } },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Compared both workspaces.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    expect(result.actions).toHaveLength(2);
    expect(result.actions.map((a) => a.ok)).toEqual([true, true]);

    const secondCallContents = generateAgentTurnMock.mock.calls[1][0].contents;
    const functionTurn = secondCallContents.find((c: { role: string }) => c.role === "function");
    expect(functionTurn.parts).toHaveLength(2);
  });

  it("threads a write action's mutated store into the next turn and the final result", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "create_workspace", args: { name: "College Research" } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Done — created College Research.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    expect(result.storeChanged).toBe(true);
    expect(result.store.workspaces.map((w) => w.name)).toEqual(["Untitled", "College Research"]);
    expect(store.workspaces).toHaveLength(1);
  });

  it("reports a failed action back to the model as an error functionResponse and continues the loop", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "move_tab", args: { tabId: "ghost", targetWorkspaceId: "a" } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "I couldn't find that tab.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    expect(result.actions).toEqual([{ name: "move_tab", ok: false, message: expect.any(String) }]);

    const secondCallContents = generateAgentTurnMock.mock.calls[1][0].contents;
    const functionTurn = secondCallContents.find((c: { role: string }) => c.role === "function");
    expect(functionTurn.parts[0].functionResponse.response.error).toBeDefined();
  });

  it("falls back to a safe message after exceeding the max tool-call iterations", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock.mockResolvedValue({
      ok: true,
      data: { text: "", functionCalls: [{ name: "list_workspaces", args: {} }] },
    });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(/trouble/i);
  });

  it("propagates a Gemini call failure without retrying", async () => {
    generateAgentTurnMock.mockResolvedValueOnce({ ok: false, reason: "rate-limited", detail: "slow down" });
    const store = makeStore([makeWorkspace({ id: "a" })], "a");

    const result = await runAgentLoop(baseParams(store));

    expect(result).toEqual({ ok: false, reason: "rate-limited", detail: "slow down" });
    expect(generateAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it("executes a single small write action immediately (no confirmation) — move_tab", async () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] }), makeWorkspace({ id: "b", name: "Research" })],
      "a"
    );
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "move_tab", args: { tabId: "1", targetWorkspaceId: "b", sourceWorkspaceId: "a" } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Moved it.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("resolved");
  });

  it("requires confirmation for a single move_tabs call that exceeds the affected-resource threshold", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, url: `https://x.com/${i}`, normalizedUrl: `https://x.com/${i}`, domain: "x.com" }));
    const store = makeStore([makeWorkspace({ id: "a", tabs: many }), makeWorkspace({ id: "b", name: "Research" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          text: "",
          functionCalls: [{ name: "move_tabs", args: { tabIds: many.map((t) => t.id), targetWorkspaceId: "b", sourceWorkspaceId: "a" } }],
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result");
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toMatchObject({ name: "move_tabs", label: expect.stringContaining("5 tabs"), affected: 5 });
    expect(result.summary).toContain("move 5 tabs");
    // Nothing was actually moved — the original store passed in is untouched.
    expect(store.workspaces[0].tabs).toHaveLength(5);
  });

  it("requires confirmation for multiple write actions in one request, even if each is individually small", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          text: "",
          functionCalls: [
            { name: "create_group", args: { workspaceId: "a", name: "Physics IA" } },
            { name: "create_group", args: { workspaceId: "a", name: "Research" } },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result");
    expect(result.plan).toHaveLength(2);
    expect(result.plan.map((p) => p.label)).toEqual([
      'Create group → "Physics IA"',
      'Create group → "Research"',
    ]);
    expect(result.summary).toContain("create 2 groups");
  });

  it("keeps a multi-step plan coherent during planning (a later step referencing an earlier not-yet-real workspace) without touching the real store", async () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] })], "a");

    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "create_workspace", args: { name: "College Research" } }] },
      })
      .mockImplementationOnce(async (opts: { contents: Array<{ role: string; parts: Array<{ functionResponse?: { response?: { result?: { workspace?: { workspaceId: string } } } } }> }> }) => {
        // The staged create_workspace's real-shaped id must be visible here so the next call can target it.
        const functionTurn = opts.contents.find((c) => c.role === "function");
        const stagedId = functionTurn?.parts[0]?.functionResponse?.response?.result?.workspace?.workspaceId;
        return {
          ok: true,
          data: { text: "", functionCalls: [{ name: "move_tab", args: { tabId: "1", targetWorkspaceId: stagedId, sourceWorkspaceId: "a" } }] },
        };
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result (2 write actions)");
    expect(result.plan).toHaveLength(2);
    expect(result.plan[0].name).toBe("create_workspace");
    expect(result.plan[1].name).toBe("move_tab");
    // The move step targeted the staged workspace by its (staged) id, and its own dry-run resolved that id's name.
    expect(result.plan[1].label).toContain("College Research");
    // Nothing committed to the real store passed in.
    expect(store.workspaces).toHaveLength(1);
  });

  it("chains search_tabs into move_tabs within the same request, using the exact tab ids the search returned", async () => {
    const physicsTabs = [
      { id: "t1", url: "https://x.com/1", normalizedUrl: "https://x.com/1", domain: "x.com", title: "Physics IA notes" },
      { id: "t2", url: "https://x.com/2", normalizedUrl: "https://x.com/2", domain: "x.com", title: "Physics IA lab" },
      { id: "t3", url: "https://x.com/3", normalizedUrl: "https://x.com/3", domain: "x.com", title: "Physics IA references" },
      { id: "t4", url: "https://x.com/4", normalizedUrl: "https://x.com/4", domain: "x.com", title: "Physics IA data" },
      { id: "t5", url: "https://x.com/5", normalizedUrl: "https://x.com/5", domain: "x.com", title: "Shopping list" },
    ];
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: physicsTabs }), makeWorkspace({ id: "b", name: "MUN Research" })],
      "a"
    );

    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "search_tabs", args: { query: "physics ia" } }] },
      })
      .mockImplementationOnce(async (opts: { contents: Array<{ role: string; parts: Array<{ functionResponse?: { response?: { result?: { matches?: { tabId: string }[] } } } }> }> }) => {
        const functionTurn = opts.contents.find((c) => c.role === "function");
        const matches = functionTurn?.parts[0]?.functionResponse?.response?.result?.matches ?? [];
        return {
          ok: true,
          data: {
            text: "",
            functionCalls: [
              { name: "move_tabs", args: { tabIds: matches.map((m) => m.tabId), targetWorkspaceId: "b", sourceWorkspaceId: "a" } },
            ],
          },
        };
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result (4 tabs moved > threshold)");
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].name).toBe("move_tabs");
    expect((result.plan[0].args as { tabIds: string[] }).tabIds.sort()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(result.searchResults?.map((r) => r.tabId).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("chains search_tabs into create_group in the same request", async () => {
    const store = makeStore([makeWorkspace({ id: "a", name: "Model UN", tabs: [] })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "search_tabs", args: { query: "MUN" } }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "create_group", args: { workspaceId: "a", name: "MUN Resolutions" } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Created the group.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (single small write) result");
    expect(result.store.workspaces[0].groups?.[0].name).toBe("MUN Resolutions");
  });

  it("passes semanticHints through to search_tabs so it can find tabs with no keyword overlap", async () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com", title: "S2 star orbit simulation" }] })],
      "a"
    );
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "search_tabs", args: { query: "orbital mechanics" } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Found it.", functionCalls: [] } });

    const result = await runAgentLoop({
      ...baseParams(store),
      semanticHints: [{ tabId: "1", workspaceId: "a", score: 0.85 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.searchResults).toEqual([expect.objectContaining({ tabId: "1", matchReason: "semantic" })]);
  });

  it("executes a single open_tabs call immediately and attaches args/data for client-side execution", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "open_tabs", args: { urls: ["https://a.com", "https://b.com"] } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Opened them.", functionCalls: [] } });

    const result = await runAgentLoop({
      ...baseParams(store),
      browserContext: { tabs: [], windows: [], activeTabId: null },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    expect(result.actions).toEqual([
      {
        name: "open_tabs",
        ok: true,
        message: expect.any(String),
        args: { urls: ["https://a.com", "https://b.com"], newWindow: undefined },
        data: { urlCount: 2, urls: ["https://a.com", "https://b.com"] },
      },
    ]);
  });

  it("requires confirmation for a bulk close_tabs call even though it's a single tool call", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "close_tabs", args: { tabIds: [1, 2, 3] } }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

    const result = await runAgentLoop({
      ...baseParams(store),
      browserContext: {
        tabs: [
          { tabId: 1, windowId: 1, url: "https://a.com", title: "A", pinned: false, active: false, index: 0 },
          { tabId: 2, windowId: 1, url: "https://b.com", title: "B", pinned: false, active: false, index: 1 },
          { tabId: 3, windowId: 1, url: "https://c.com", title: "C", pinned: false, active: false, index: 2 },
        ],
        windows: [],
        activeTabId: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result");
    expect(result.plan[0]).toMatchObject({ name: "close_tabs", affected: 3 });
  });

  it("reports a clear error when a browser action is called without a connected extension", async () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    generateAgentTurnMock
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "list_browser_tabs", args: {} }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "I can't see your browser tabs right now.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved result");
    expect(result.actions).toEqual([{ name: "list_browser_tabs", ok: false, message: expect.stringContaining("isn't connected") }]);
  });

  it("never lets search_tabs results leak vector/embedding data into the loop's output", async () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com", title: "Physics" }] })],
      "a"
    );
    generateAgentTurnMock
      .mockResolvedValueOnce({ ok: true, data: { text: "", functionCalls: [{ name: "search_tabs", args: { query: "physics" } }] } })
      .mockResolvedValueOnce({ ok: true, data: { text: "Found it.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.searchResults);
    expect(serialized).not.toContain("embedding");
  });
});

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

/**
 * Locates the turn runAgentLoop pushes to report a tool's result back to
 * Gemini. That turn is `role: "user"` (Gemini's contents schema has no
 * "function" role — see AgentContent's doc in src/lib/ai/gemini/types.ts),
 * so — unlike before this was fixed — it can no longer be found by role
 * alone: `contents` also always carries the ORIGINAL role: "user" question
 * turn from baseParams. Identifying it by its distinctive part shape
 * (functionResponse) instead is what actually proves the fix: it only ever
 * matches the tool-result turn, never the plain-text user turn, even though
 * both now share the same role.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only helper over Gemini's loosely-typed wire contents; matches this file's prior convention of not modeling the full response shape here.
function findFunctionResponseTurn(contents: Array<{ role: string; parts: Array<{ functionResponse?: unknown }> }>): any {
  const turn = contents.find((c) => c.parts.some((p) => "functionResponse" in p));
  if (!turn) throw new Error("expected a functionResponse turn in contents");
  return turn;
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
    const functionTurn = findFunctionResponseTurn(secondCallContents);
    expect(functionTurn.role).toBe("user"); // Gemini has no "function" role — a tool result is reported as role: "user"
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
    const functionTurn = findFunctionResponseTurn(secondCallContents);
    expect(functionTurn.role).toBe("user");
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
    const functionTurn = findFunctionResponseTurn(secondCallContents);
    expect(functionTurn.role).toBe("user");
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
        expect(opts.contents.every((c) => c.role === "user" || c.role === "model")).toBe(true); // never "function"
        const functionTurn = opts.contents.find((c) => c.parts.some((p) => p.functionResponse));
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
        expect(opts.contents.every((c) => c.role === "user" || c.role === "model")).toBe(true); // never "function"
        const functionTurn = opts.contents.find((c) => c.parts.some((p) => p.functionResponse));
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
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
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
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    const serialized = JSON.stringify(result.searchResults);
    expect(serialized).not.toContain("embedding");
  });

  it("short-circuits to an 'organize' result the moment propose_auto_organize succeeds, without letting Gemini keep building its own plan", async () => {
    const store = makeStore(
      [
        makeWorkspace({
          id: "a",
          tabs: [
            { id: "t1", url: "https://a.example/1", normalizedUrl: "https://a.example/1", domain: "a.example", title: "Physics IA Notes" },
            { id: "t2", url: "https://b.example/2", normalizedUrl: "https://b.example/2", domain: "b.example", title: "Physics Orbital Mechanics" },
            { id: "t3", url: "https://c.example/3", normalizedUrl: "https://c.example/3", domain: "c.example", title: "Physics Lab Report" },
            { id: "t4", url: "https://d.example/4", normalizedUrl: "https://d.example/4", domain: "d.example", title: "Grocery list" },
            { id: "t5", url: "https://e.example/5", normalizedUrl: "https://e.example/5", domain: "e.example", title: "Recipe idea" },
          ],
        }),
      ],
      "a"
    );
    generateAgentTurnMock.mockResolvedValueOnce({
      ok: true,
      data: { text: "", functionCalls: [{ name: "propose_auto_organize", args: { scope: "all" } }] },
    });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "organize") throw new Error("expected an 'organize' result");
    expect(result.organizePlan.workspaces.length).toBeGreaterThan(0);
    expect(result.text).toBe(result.organizePlan.summary);
    // Only one Gemini call — it never loops back for a second turn to build create_workspace/move_tabs calls itself.
    expect(generateAgentTurnMock).toHaveBeenCalledTimes(1);
    // The scratch store used for planning was never mutated (propose_auto_organize is read-only).
    expect(store.workspaces[0].tabs).toHaveLength(5);
  });

  /**
   * Regression test for the production bug where a tool result was reported
   * back with `role: "function"` — a role Gemini's contents schema doesn't
   * support ("Role 'function' is not supported. Please use a valid role:
   * ... MODEL, USER."), which broke every tool-calling turn, including
   * ordinary requests that only happened to route through the agent loop.
   * This reproduces a multi-turn, multiple-tool-calls-per-turn conversation
   * (the exact shape that produces a functionResponse turn) using the real
   * runAgentLoop, and inspects every request `generateAgentTurn` was
   * actually called with — not just one hand-picked turn — so a role:
   * "function" leaking in from anywhere in the loop would fail this.
   */
  it("never sends a Gemini-unsupported role: 'function' content — every request role is 'user' or 'model'", async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        data: { text: "", functionCalls: [{ name: "list_workspaces", args: {} }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { text: "Here's a summary of both workspaces.", functionCalls: [] } });

    const result = await runAgentLoop(baseParams(store));

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved (immediate) result");
    expect(result.text).toBe("Here's a summary of both workspaces.");

    // Inspect the `contents` array of EVERY call made to generateAgentTurn —
    // this is the exact payload generateAgentTurn hands to
    // `body.contents = opts.contents.map((c) => ({ role: c.role, parts: c.parts }))`
    // in src/lib/ai/gemini/client.ts, i.e. what Gemini actually receives.
    expect(generateAgentTurnMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of generateAgentTurnMock.mock.calls) {
      const contents = call[0].contents as Array<{ role: string }>;
      expect(contents.some((c) => c.role === "function")).toBe(false);
      expect(contents.every((c) => c.role === "user" || c.role === "model")).toBe(true);
      const serialized = JSON.stringify(contents);
      expect(serialized).not.toContain('"role":"function"');
    }

    // And the two functionResponse turns (one per intermediate tool-calling
    // turn) are specifically role: "user" — this is the part of the fix
    // that actually matters, not just "not function".
    const secondCallFunctionTurn = findFunctionResponseTurn(generateAgentTurnMock.mock.calls[1][0].contents);
    expect(secondCallFunctionTurn.role).toBe("user");
    const thirdCallFunctionTurn = findFunctionResponseTurn(generateAgentTurnMock.mock.calls[2][0].contents);
    expect(thirdCallFunctionTurn.role).toBe("user");
  });

  it("keeps the plain (no-tool) chat path unaffected — no functionResponse turn is ever added when the model never calls a tool", async () => {
    generateAgentTurnMock.mockResolvedValueOnce({ ok: true, data: { text: "Just an answer, no tools needed.", functionCalls: [] } });
    const store = makeStore([makeWorkspace({ id: "a" })], "a");

    const result = await runAgentLoop(baseParams(store));

    expect(result).toEqual({ ok: true, kind: "resolved", text: "Just an answer, no tools needed.", store, storeChanged: false, actions: [] });
    const onlyCallContents = generateAgentTurnMock.mock.calls[0][0].contents as Array<{ role: string }>;
    expect(onlyCallContents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  describe("thoughtSignature preservation (Gemini 3)", () => {
    /**
     * Regression test for the production error: "Function call is missing a
     * thought_signature in functionCall parts... function call
     * default_api:list_workspaces" — reproduces the EXACT failing call name
     * from production. Gemini requires a thoughtSignature it returned on a
     * functionCall Part to be replayed back byte-for-byte, attached to that
     * same Part, on the very next request that includes this model turn in
     * its history. This drives the real runAgentLoop end to end and
     * inspects the second request's `contents` — the actual payload the
     * next generateAgentTurn call would send to Gemini.
     */
    it("replays a single tool call's thoughtSignature back on its model turn, unmodified and not moved elsewhere", async () => {
      const store = makeStore([makeWorkspace({ id: "a", name: "Physics" })], "a");
      generateAgentTurnMock
        .mockResolvedValueOnce({
          ok: true,
          data: { text: "", functionCalls: [{ name: "list_workspaces", args: {}, thoughtSignature: "SIG_LIST_WORKSPACES" }] },
        })
        .mockResolvedValueOnce({ ok: true, data: { text: "You have one workspace: Physics.", functionCalls: [] } });

      const result = await runAgentLoop(baseParams(store));
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved result");

      const secondCallContents = generateAgentTurnMock.mock.calls[1][0].contents as Array<{
        role: string;
        parts: Array<{ functionCall?: { name: string; args: unknown }; functionResponse?: unknown; thoughtSignature?: string }>;
      }>;

      const modelTurn = secondCallContents.find((c) => c.role === "model");
      if (!modelTurn) throw new Error("expected a model turn carrying the functionCall");
      // EXACT shape Gemini requires: thoughtSignature is a SIBLING of
      // functionCall on the Part, not nested inside functionCall itself,
      // and not renamed/re-encoded/truncated.
      expect(modelTurn.parts).toEqual([
        { functionCall: { name: "list_workspaces", args: {} }, thoughtSignature: "SIG_LIST_WORKSPACES" },
      ]);

      // Never leaked into the functionResponse turn, never into the user's
      // own message, never dropped.
      const responseTurn = findFunctionResponseTurn(secondCallContents);
      expect(JSON.stringify(responseTurn)).not.toContain("SIG_LIST_WORKSPACES");
      const userQuestionTurn = secondCallContents[0];
      expect(JSON.stringify(userQuestionTurn)).not.toContain("SIG_LIST_WORKSPACES");
    });

    it("preserves a parallel batch's thoughtSignature only on the part Gemini actually signed, never inventing one for the rest", async () => {
      const store = makeStore(
        [makeWorkspace({ id: "a", name: "A" }), makeWorkspace({ id: "b", name: "Model UN", tabs: [] })],
        "a"
      );
      generateAgentTurnMock
        .mockResolvedValueOnce({
          ok: true,
          data: {
            text: "",
            functionCalls: [
              { name: "list_workspaces", args: {}, thoughtSignature: "SIG_A" },
              { name: "search_tabs", args: { query: "MUN" } }, // no signature — must not gain one
            ],
          },
        })
        .mockResolvedValueOnce({ ok: true, data: { text: "Here you go.", functionCalls: [] } });

      const result = await runAgentLoop(baseParams(store));
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "resolved") throw new Error("expected a resolved result");

      const secondCallContents = generateAgentTurnMock.mock.calls[1][0].contents as Array<{
        role: string;
        parts: Array<{ functionCall?: { name: string }; thoughtSignature?: string }>;
      }>;
      const modelTurn = secondCallContents.find((c) => c.role === "model");
      if (!modelTurn) throw new Error("expected a model turn");
      expect(modelTurn.parts).toHaveLength(2);
      expect(modelTurn.parts[0]).toEqual({ functionCall: { name: "list_workspaces", args: {} }, thoughtSignature: "SIG_A" });
      expect(modelTurn.parts[1]).toEqual({ functionCall: { name: "search_tabs", args: { query: "MUN" } } });
      // Strict "never invented" check — an explicit `undefined` would still
      // pass a plain toEqual, so assert the key itself is genuinely absent.
      expect(Object.prototype.hasOwnProperty.call(modelTurn.parts[1], "thoughtSignature")).toBe(false);
    });

    it("preserves each sequential step's own thoughtSignature in its own model turn across a multi-step plan", async () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] })], "a");

      generateAgentTurnMock
        .mockResolvedValueOnce({
          ok: true,
          data: { text: "", functionCalls: [{ name: "create_workspace", args: { name: "College Research" }, thoughtSignature: "SIG_A" }] },
        })
        .mockImplementationOnce(
          async (opts: {
            contents: Array<{ role: string; parts: Array<{ functionResponse?: { response?: { result?: { workspace?: { workspaceId: string } } } } }> }>;
          }) => {
            const functionTurn = opts.contents.find((c) => c.parts.some((p) => p.functionResponse));
            const stagedId = functionTurn?.parts[0]?.functionResponse?.response?.result?.workspace?.workspaceId;
            return {
              ok: true,
              data: { text: "", functionCalls: [{ name: "move_tab", args: { tabId: "1", targetWorkspaceId: stagedId, sourceWorkspaceId: "a" }, thoughtSignature: "SIG_B" }] },
            };
          }
        )
        .mockResolvedValueOnce({ ok: true, data: { text: "Here's what I want to change", functionCalls: [] } });

      const result = await runAgentLoop(baseParams(store));
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "preview") throw new Error("expected a preview result (2 write actions)");

      // The THIRD call's contents carry BOTH prior model turns — each must
      // still hold its own original signature, unmodified and un-swapped.
      const thirdCallContents = generateAgentTurnMock.mock.calls[2][0].contents as Array<{
        role: string;
        parts: Array<{ functionCall?: { name: string }; thoughtSignature?: string }>;
      }>;
      const modelTurns = thirdCallContents.filter((c) => c.role === "model");
      expect(modelTurns).toHaveLength(2);
      expect(modelTurns[0].parts[0]).toMatchObject({ functionCall: { name: "create_workspace" }, thoughtSignature: "SIG_A" });
      expect(modelTurns[1].parts[0]).toMatchObject({ functionCall: { name: "move_tab" }, thoughtSignature: "SIG_B" });
    });
  });
});

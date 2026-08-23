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

    expect(result).toEqual({ ok: true, text: "Just an answer.", store, storeChanged: false, actions: [] });
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
    if (!result.ok) return;
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
    if (!result.ok) return;
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
    if (!result.ok) return;
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
});

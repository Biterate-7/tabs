import "fake-indexeddb/auto";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAskTabDump } from "./use-ask-tabdump";
import { putChunks } from "@/lib/ai/db";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

const WORKSPACE_ID = "ws-hook-repro";

function textStreamResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const tabs: Tab[] = [
  { id: "tab-1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com", category: "research", title: "Example" },
];

beforeEach(async () => {
  await putChunks([
    {
      key: `${WORKSPACE_ID}:tab-1:summary`,
      workspaceId: WORKSPACE_ID,
      tabId: "tab-1",
      kind: "summary",
      text: "Example summary",
      embedding: [1, 0, 0],
      tabSignature: "sig",
      title: "Example",
      url: "https://example.com/a",
      indexedAt: Date.now(),
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("isSending returns to false after the first response, via the real hook", async () => {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) return textStreamResponse("Answer");
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs));

  act(() => {
    result.current.send("Q1");
  });

  await waitFor(() => expect(result.current.isSending).toBe(true));
  console.log("after send(): isSending =", result.current.isSending, "messages =", result.current.messages.length);

  await waitFor(
    () => {
      console.log("polling: isSending =", result.current.isSending, JSON.stringify(result.current.messages));
      expect(result.current.isSending).toBe(false);
    },
    { timeout: 3000, interval: 100 }
  );
});

const allWorkspaces: Workspace[] = [{ id: WORKSPACE_ID, name: "Physics", tabs, createdAt: 0, updatedAt: 0 }];

const plan = [
  { name: "create_group", args: { workspaceId: WORKSPACE_ID, name: "Physics IA" }, label: 'Create group → "Physics IA"', affected: 1 },
  { name: "create_group", args: { workspaceId: WORKSPACE_ID, name: "Research" }, label: 'Create group → "Research"', affected: 1 },
];

function mockAgentFetch(opts: { onApply?: () => Response | Promise<Response> }) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.mode === "agent-apply") {
        return opts.onApply
          ? await opts.onApply()
          : new Response(
              JSON.stringify({
                text: "Done — created 2 groups.",
                actions: [],
                store: { version: 1, currentId: WORKSPACE_ID, workspaces: [{ ...allWorkspaces[0], groups: [{ id: "g1", name: "Physics IA", createdAt: 0, updatedAt: 0 }] }] },
              }),
              { status: 200 }
            );
      }
      // mode: "agent" — always propose the same 2-action plan for "Organize this workspace"
      return new Response(
        JSON.stringify({ requiresConfirmation: true, text: "Here's what I want to change", plan, summary: "This will create 2 groups." }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

it("shows a preview, applies it on approval, updates the store, and leaves the conversation usable afterward", async () => {
  const onStoreUpdate = vi.fn();
  mockAgentFetch({});

  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const previewMessage = result.current.messages.find((m) => m.preview);
  expect(previewMessage?.preview?.status).toBe("awaiting");
  expect(previewMessage?.preview?.plan).toHaveLength(2);
  expect(previewMessage?.preview?.summary).toBe("This will create 2 groups.");

  await act(async () => {
    await result.current.applyPreview(previewMessage!.id);
  });

  expect(onStoreUpdate).toHaveBeenCalledTimes(1);
  const updatedMessage = result.current.messages.find((m) => m.id === previewMessage!.id);
  expect(updatedMessage?.preview?.status).toBe("applied");
  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.role).toBe("assistant");
  expect(followUp.text).toBe("Done — created 2 groups.");

  // Conversation stays usable: a normal follow-up question still works.
  act(() => {
    result.current.send("What did I just do?")
  });
  await waitFor(() => expect(result.current.isSending).toBe(true));
  await waitFor(() => expect(result.current.isSending).toBe(false));
  expect(result.current.messages[result.current.messages.length - 1].role).toBe("assistant");
});

it("cancelPreview executes nothing and appends a cancellation message", async () => {
  const onStoreUpdate = vi.fn();
  const fetchMock = mockAgentFetch({});

  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const previewMessage = result.current.messages.find((m) => m.preview)!;
  const callsBeforeCancel = fetchMock.mock.calls.length;

  act(() => {
    result.current.cancelPreview(previewMessage.id)
  });

  expect(fetchMock.mock.calls.length).toBe(callsBeforeCancel); // no new fetch — nothing executed
  expect(onStoreUpdate).not.toHaveBeenCalled();
  const updated = result.current.messages.find((m) => m.id === previewMessage.id);
  expect(updated?.preview?.status).toBe("cancelled");
  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.text).toBe("No changes made.");

  // Conversation is still usable after cancelling.
  act(() => {
    result.current.send("Ask something else")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
});

it("does not execute an already-resolved preview a second time", async () => {
  const onStoreUpdate = vi.fn();
  mockAgentFetch({});
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const previewMessage = result.current.messages.find((m) => m.preview)!;
  await act(async () => {
    await result.current.applyPreview(previewMessage.id);
  });
  expect(onStoreUpdate).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.applyPreview(previewMessage.id);
  });
  expect(onStoreUpdate).toHaveBeenCalledTimes(1); // still just once — status is no longer "awaiting"
});

it("does not execute a plan twice when Apply is clicked rapidly before the first request resolves", async () => {
  let resolveApply!: (r: Response) => void;
  const applyPromise = new Promise<Response>((resolve) => {
    resolveApply = resolve;
  });
  let applyCallCount = 0;
  const fetchMock = mockAgentFetch({
    onApply: () => {
      applyCallCount += 1;
      return applyPromise;
    },
  });

  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const previewMessage = result.current.messages.find((m) => m.preview)!;

  // Fire two "clicks" back-to-back without awaiting the first.
  let firstDone = false;
  let secondDone = false;
  const first = result.current.applyPreview(previewMessage.id).then(() => {
    firstDone = true;
  });
  const second = result.current.applyPreview(previewMessage.id).then(() => {
    secondDone = true;
  });

  expect(applyCallCount).toBe(1); // the second call was blocked synchronously, before the network even started

  resolveApply(
    new Response(
      JSON.stringify({
        text: "Done — created 2 groups.",
        actions: [],
        store: { version: 1, currentId: WORKSPACE_ID, workspaces: allWorkspaces },
      }),
      { status: 200 }
    )
  );
  await act(async () => {
    await Promise.all([first, second]);
  });

  expect(firstDone).toBe(true);
  expect(secondDone).toBe(true);
  expect(applyCallCount).toBe(1);
  expect(fetchMock.mock.calls.filter((c) => JSON.parse((c[1] as RequestInit).body as string).mode === "agent-apply")).toHaveLength(1);
});

it("marks the preview as failed (and does not update the store) when applying returns an error", async () => {
  const onStoreUpdate = vi.fn();
  mockAgentFetch({ onApply: () => new Response(JSON.stringify({ error: "Something failed." }), { status: 500 }) });

  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const previewMessage = result.current.messages.find((m) => m.preview)!;

  await act(async () => {
    await result.current.applyPreview(previewMessage.id);
  });

  expect(onStoreUpdate).not.toHaveBeenCalled();
  const updated = result.current.messages.find((m) => m.id === previewMessage.id);
  expect(updated?.preview?.status).toBe("failed");
  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.text).toContain("Something went wrong");
  // No coherent resulting state — nothing to make undoable.
  expect(result.current.messages.some((m) => m.undo)).toBe(false);
});

it("cancelling a preview never creates an undo entry", async () => {
  const onStoreUpdate = vi.fn();
  mockAgentFetch({});
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const previewMessage = result.current.messages.find((m) => m.preview)!;

  act(() => {
    result.current.cancelPreview(previewMessage.id)
  });

  expect(result.current.messages.some((m) => m.undo)).toBe(false);
});

it("applying a preview creates an undo entry on the follow-up 'Done' message", async () => {
  const onStoreUpdate = vi.fn();
  mockAgentFetch({});
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces, onStoreUpdate));

  act(() => {
    result.current.send("Organize this workspace")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const previewMessage = result.current.messages.find((m) => m.preview)!;

  await act(async () => {
    await result.current.applyPreview(previewMessage.id);
  });

  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.text).toBe("Done — created 2 groups.");
  expect(followUp.undo?.status).toBe("available");
});

/** Queues one response per successive call to /api/ai/ask (mode "agent"); embed calls always succeed generically. */
function mockSequentialAgentFetch(responses: Array<{ text: string; actions: unknown[]; store: unknown }>) {
  let call = 0;
  return vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      const response = responses[call];
      call += 1;
      return new Response(JSON.stringify(response), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

function storeWith(workspaces: Workspace[]): WorkspaceStore {
  return { version: 1, currentId: WORKSPACE_ID, workspaces };
}

it("creates an undo entry for an immediate (non-preview) mutation, and Undo restores the exact previous store", async () => {
  const before = storeWith(allWorkspaces);
  const after = storeWith([{ ...allWorkspaces[0], groups: [{ id: "g1", name: "Physics IA", createdAt: 0, updatedAt: 0 }] }]);

  const onStoreUpdate = vi.fn();
  mockSequentialAgentFetch([{ text: "Done — moved 8 tabs into Physics IA.", actions: [], store: after }]);

  // Mirrors production: AppShell re-renders WorkspaceView/AskTabDumpPanel
  // with the freshly-persisted `allWorkspaces` once onStoreUpdate fires —
  // so undoAction's later staleness check sees the post-mutation state,
  // not the pre-mutation snapshot the hook was first created with.
  const { result, rerender } = renderHook(
    ({ ws }: { ws: Workspace[] }) => useAskTabDump(WORKSPACE_ID, tabs, ws, onStoreUpdate),
    { initialProps: { ws: allWorkspaces } }
  );

  act(() => {
    result.current.send("Move my Physics tabs.")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const msg = result.current.messages.find((m) => m.undo);
  expect(msg?.text).toBe("Done — moved 8 tabs into Physics IA.");
  expect(msg?.undo?.status).toBe("available");
  expect(onStoreUpdate).toHaveBeenCalledTimes(1);
  expect(onStoreUpdate).toHaveBeenCalledWith(after);
  rerender({ ws: after.workspaces });

  await act(async () => {
    await result.current.undoAction(msg!.undo!.entryId);
  });

  expect(onStoreUpdate).toHaveBeenCalledTimes(2);
  expect(onStoreUpdate).toHaveBeenLastCalledWith(before);

  const updatedMsg = result.current.messages.find((m) => m.id === msg!.id);
  expect(updatedMsg?.undo?.status).toBe("undone");
  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.role).toBe("assistant");
  expect(followUp.text).toBe("↶ Undid that change.");

  // The conversation stays usable: a brand-new AI request works normally afterward.
  act(() => {
    result.current.send("Actually, move them into Research instead.")
  });
  await waitFor(() => expect(result.current.isSending).toBe(true));
  await waitFor(() => expect(result.current.isSending).toBe(false));
  expect(result.current.messages[result.current.messages.length - 1].role).toBe("assistant");
});

it("does not allow the same operation to be undone twice, even called back-to-back", async () => {
  const after = storeWith([{ ...allWorkspaces[0], groups: [{ id: "g1", name: "Physics IA", createdAt: 0, updatedAt: 0 }] }]);
  const onStoreUpdate = vi.fn();
  mockSequentialAgentFetch([{ text: "Done — moved 8 tabs into Physics IA.", actions: [], store: after }]);

  const { result, rerender } = renderHook(
    ({ ws }: { ws: Workspace[] }) => useAskTabDump(WORKSPACE_ID, tabs, ws, onStoreUpdate),
    { initialProps: { ws: allWorkspaces } }
  );
  act(() => {
    result.current.send("Move my Physics tabs.")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const msg = result.current.messages.find((m) => m.undo)!;
  rerender({ ws: after.workspaces });

  const first = result.current.undoAction(msg.undo!.entryId);
  const second = result.current.undoAction(msg.undo!.entryId);
  await act(async () => {
    await Promise.all([first, second]);
  });

  // One mutation call + exactly one undo call — the repeat/duplicate call was a no-op.
  expect(onStoreUpdate).toHaveBeenCalledTimes(2);
});

it("refuses to undo when the workspace has changed since the AI mutation, without discarding the newer state", async () => {
  const before = storeWith(allWorkspaces);
  const after = storeWith([{ ...allWorkspaces[0], groups: [{ id: "g1", name: "Physics IA", createdAt: 0, updatedAt: 0 }] }]);

  const onStoreUpdate = vi.fn();
  mockSequentialAgentFetch([{ text: "Done — moved 8 tabs into Physics IA.", actions: [], store: after }]);

  const { result, rerender } = renderHook(
    ({ ws }: { ws: Workspace[] }) => useAskTabDump(WORKSPACE_ID, tabs, ws, onStoreUpdate),
    { initialProps: { ws: allWorkspaces } }
  );

  act(() => {
    result.current.send("Move my Physics tabs.")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  const msg = result.current.messages.find((m) => m.undo)!;

  // Simulate the user manually changing the workspace after the AI action
  // (e.g. renaming it) by re-rendering with a different `allWorkspaces` —
  // exactly what AppShell handing down a newly-persisted store looks like.
  const manuallyChanged: Workspace[] = [{ ...after.workspaces[0], name: "Physics (renamed by user)" }];
  rerender({ ws: manuallyChanged });

  await act(async () => {
    await result.current.undoAction(msg.undo!.entryId);
  });

  // Refused: only the original mutation's onStoreUpdate call happened — the
  // manual rename was never overwritten.
  expect(onStoreUpdate).toHaveBeenCalledTimes(1);
  expect(onStoreUpdate).not.toHaveBeenCalledWith(before);

  const updatedMsg = result.current.messages.find((m) => m.id === msg.id);
  expect(updatedMsg?.undo?.status).toBe("unavailable");
  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.text).toContain("can't safely undo");
});

it("supports undoing only the latest of several AI operations, leaving earlier ones intact and available (A → B → C)", async () => {
  const s0 = storeWith(allWorkspaces);
  const s1 = storeWith([{ ...allWorkspaces[0], name: "Physics (A)" }]);
  const s2 = storeWith([{ ...s1.workspaces[0], groups: [{ id: "g1", name: "Research", createdAt: 0, updatedAt: 0 }] }]);
  const s3 = storeWith([{ ...s2.workspaces[0], groups: [...s2.workspaces[0].groups!, { id: "g2", name: "MUN", createdAt: 0, updatedAt: 0 }] }]);

  const onStoreUpdate = vi.fn();
  mockSequentialAgentFetch([
    { text: "A done", actions: [], store: s1 },
    { text: "B done", actions: [], store: s2 },
    { text: "C done", actions: [], store: s3 },
  ]);

  const { result, rerender } = renderHook(
    ({ ws }: { ws: Workspace[] }) => useAskTabDump(WORKSPACE_ID, tabs, ws, onStoreUpdate),
    { initialProps: { ws: s0.workspaces } }
  );

  act(() => {
    result.current.send("A")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  rerender({ ws: s1.workspaces }); // the store really did update to s1, as persist() would reflect

  act(() => {
    result.current.send("B")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  rerender({ ws: s2.workspaces });

  act(() => {
    result.current.send("C")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));
  rerender({ ws: s3.workspaces });

  const undoMessages = result.current.messages.filter((m) => m.undo);
  expect(undoMessages).toHaveLength(3);
  const [msgA, msgB, msgC] = undoMessages;

  // Undo C: current store (s3) matches C's afterState, so it succeeds and restores s2.
  await act(async () => {
    await result.current.undoAction(msgC.undo!.entryId);
  });
  expect(onStoreUpdate).toHaveBeenLastCalledWith(s2);
  rerender({ ws: s2.workspaces });

  // B is untouched by undoing C, and is still available.
  expect(result.current.messages.find((m) => m.id === msgB.id)?.undo?.status).toBe("available");
  expect(result.current.messages.find((m) => m.id === msgA.id)?.undo?.status).toBe("available");

  // B is now safely undoable too: current store (s2) matches B's afterState.
  await act(async () => {
    await result.current.undoAction(msgB.undo!.entryId);
  });
  expect(onStoreUpdate).toHaveBeenLastCalledWith(s1);

  // A was never invoked — its entry is exactly as it was, never consumed by undoing B or C.
  expect(result.current.messages.find((m) => m.id === msgA.id)?.undo?.status).toBe("available");
});

const physicsSearchResults = [
  { tabId: "t1", title: "Physics IA notes", url: "https://x.com/1", domain: "x.com", workspaceId: WORKSPACE_ID, workspaceName: "Physics", score: 6, matchReason: "title" as const },
  { tabId: "t2", title: "Physics IA lab", url: "https://github.com/x", domain: "github.com", workspaceId: WORKSPACE_ID, workspaceName: "Physics", score: 4, matchReason: "title" as const },
];

/** First call ("Find my physics tabs") returns search results; the second call ("Move those...") asserts recentSearchResults was sent, then resolves as an immediate move. */
function mockSearchThenActFetch() {
  let call = 0;
  let capturedSecondBody: Record<string, unknown> | null = null;
  const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ text: "I found 2 relevant tabs in Physics.", actions: [], searchResults: physicsSearchResults }),
          { status: 200 }
        );
      }
      capturedSecondBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          text: "Done — moved 2 tabs into Physics IA.",
          actions: [],
          store: { version: 1, currentId: WORKSPACE_ID, workspaces: allWorkspaces },
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  return { fetchMock, getSecondBody: () => capturedSecondBody };
}

it("attaches searchResults to the assistant message that ran a search", async () => {
  mockSearchThenActFetch();
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces));

  act(() => {
    result.current.send("Find my physics tabs")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const searchMessage = result.current.messages.find((m) => m.searchResults);
  expect(searchMessage?.searchResults).toEqual(physicsSearchResults);
  expect(searchMessage?.text).toBe("I found 2 relevant tabs in Physics.");
});

it("preserves search results across turns so a follow-up like 'move those' resolves without re-searching or manual tab ids", async () => {
  const { getSecondBody } = mockSearchThenActFetch();
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces));

  act(() => {
    result.current.send("Find my physics tabs")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  act(() => {
    result.current.send("Move those into Physics IA")
  });
  await waitFor(() => expect(result.current.isSending).toBe(true));
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const secondBody = getSecondBody();
  expect(secondBody?.recentSearchResults).toEqual(physicsSearchResults);

  const followUp = result.current.messages[result.current.messages.length - 1];
  expect(followUp.text).toBe("Done — moved 2 tabs into Physics IA.");
  // The conversation kept both turns intact — nothing was dropped or replaced.
  expect(result.current.messages.map((m) => m.text)).toEqual([
    "Find my physics tabs",
    "I found 2 relevant tabs in Physics.",
    "Move those into Physics IA",
    "Done — moved 2 tabs into Physics IA.",
  ]);
});

it("forgets recent search results once the conversation is cleared", async () => {
  const { fetchMock } = mockSearchThenActFetch();
  const { result } = renderHook(() => useAskTabDump(WORKSPACE_ID, tabs, allWorkspaces));

  act(() => {
    result.current.send("Find my physics tabs")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  act(() => {
    result.current.clear()
  });

  act(() => {
    result.current.send("Move those into Physics IA")
  });
  await waitFor(() => expect(result.current.isSending).toBe(false));

  const lastCallBody = JSON.parse((fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit).body as string);
  expect(lastCallBody.recentSearchResults).toEqual([]);
});

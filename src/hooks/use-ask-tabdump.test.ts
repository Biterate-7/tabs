import "fake-indexeddb/auto";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAskTabDump } from "./use-ask-tabdump";
import { putChunks } from "@/lib/ai/db";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

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
});

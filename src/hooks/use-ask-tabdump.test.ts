import "fake-indexeddb/auto";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAskTabDump } from "./use-ask-tabdump";
import { putChunks } from "@/lib/ai/db";
import type { Tab } from "@/lib/tabs/types";

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

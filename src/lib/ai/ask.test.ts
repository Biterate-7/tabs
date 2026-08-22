import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { askQuestion } from "./ask";
import { putChunks } from "./db";
import type { Tab } from "@/lib/tabs/types";

const WORKSPACE_ID = "ws-repro";

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

it("askQuestion resolves (does not hang) for two consecutive calls, no React involved", async () => {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) return textStreamResponse("Answer");
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const tabs: Tab[] = [
    { id: "tab-1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com", category: "research", title: "Example" },
  ];

  const r1 = await Promise.race([
    askQuestion({ workspaceId: WORKSPACE_ID, tabs, question: "Q1", history: [] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("askQuestion #1 never resolved (hung)")), 3000)),
  ]);
  expect((r1 as { ok: boolean }).ok).toBe(true);

  const r2 = await Promise.race([
    askQuestion({ workspaceId: WORKSPACE_ID, tabs, question: "Q2", history: [] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("askQuestion #2 never resolved (hung)")), 3000)),
  ]);
  expect((r2 as { ok: boolean }).ok).toBe(true);
});

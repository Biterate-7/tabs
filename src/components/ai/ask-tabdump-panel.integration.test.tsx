import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskTabDumpPanel } from "./ask-tabdump-panel";
import { putChunks } from "@/lib/ai/db";
import type { Tab } from "@/lib/tabs/types";

/**
 * Exercises the Ask TabDump chat lifecycle end to end through the REAL
 * hook/ask.ts/retrieve.ts/db.ts — only `fetch` is mocked — covering
 * multiple consecutive messages, error recovery, and duplicate-submission
 * prevention while a request is genuinely in flight.
 */

const WORKSPACE_ID = "ws-integration";

function makeTab(): Tab {
  return {
    id: "tab-1",
    url: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    domain: "example.com",
    category: "research",
    title: "Example",
  };
}

function textStreamResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

const noIndexing = { isIndexing: false, indexed: 0, total: 0 };

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

describe("AskTabDumpPanel — consecutive messages (real hook, mocked fetch)", () => {
  it("allows sending a second message after the first response completes", async () => {
    let call = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) {
        return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
      }
      if (url.includes("/api/ai/ask")) {
        call += 1;
        return textStreamResponse(`Answer ${call}`);
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={WORKSPACE_ID}
        tabs={[makeTab()]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/ask anything/i);
    const sendButton = screen.getByRole("button", { name: "Send" });

    // First message.
    await user.type(input, "First question?");
    await user.click(sendButton);
    await waitFor(() => expect(screen.getByText("Answer 1")).toBeTruthy());

    // The button is legitimately disabled right now because the input is
    // empty (cleared after sending #1) — that's correct UX, not the bug.
    // The real test is whether typing + sending a *second* message works.
    expect((input as HTMLTextAreaElement).disabled).toBe(false);

    // Second message.
    await user.type(input, "Second question?");
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(sendButton);
    await waitFor(() => expect(screen.getByText("Answer 2")).toBeTruthy());

    // Third message, sent via Enter instead of the button.
    await user.type(input, "Third question?");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Answer 3")).toBeTruthy());

    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/api/ai/ask"))).toHaveLength(3);
  }, 10000);

  it("re-enables the input after a failed request, and a retry works", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) {
        return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
      }
      if (url.includes("/api/ai/ask")) {
        return new Response(JSON.stringify({ error: "AI features aren't configured yet." }), { status: 503 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={WORKSPACE_ID}
        tabs={[makeTab()]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/ask anything/i);
    const sendButton = screen.getByRole("button", { name: "Send" });

    await user.type(input, "Will this fail?");
    await user.click(sendButton);
    await waitFor(() => expect(screen.getByText(/Something went wrong/)).toBeTruthy());

    // Must be usable again immediately after the failure, not stuck.
    await user.type(input, "Retry this one");
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(sendButton);
    await waitFor(() => expect(screen.getAllByText(/Something went wrong/)).toHaveLength(2));
  }, 10000);

  it("does not send a duplicate request when submitted rapidly while one is already in flight", async () => {
    let resolveAsk!: (r: Response) => void;
    const askPromise = new Promise<Response>((resolve) => {
      resolveAsk = resolve;
    });
    let askCallCount = 0;

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) {
        return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
      }
      if (url.includes("/api/ai/ask")) {
        askCallCount += 1;
        return askPromise;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={WORKSPACE_ID}
        tabs={[makeTab()]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/ask anything/i);
    const sendButton = screen.getByRole("button", { name: "Send" });

    await user.type(input, "Slow question?");
    // Fire several rapid submissions while the request is still pending —
    // Enter, Enter, and a click — none of these should create a second request.
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.click(sendButton);
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(true));

    resolveAsk(textStreamResponse("Answer"));
    await waitFor(() => expect(screen.getByText("Answer")).toBeTruthy());

    expect(askCallCount).toBe(1);
  }, 10000);
});

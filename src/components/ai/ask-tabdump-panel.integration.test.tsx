import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskTabDumpPanel } from "./ask-tabdump-panel";
import { putChunks } from "@/lib/ai/db";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

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

/**
 * Final UI-rendering verification for the workspace-summary truncation fix
 * (see src/lib/ai/gemini/client.ts's `truncated` flag and
 * src/lib/actions/agent.ts's withTruncationNotice()). Passing `allWorkspaces`
 * + `onStoreUpdate` (unlike the plain-chat tests above) is what turns on the
 * real hook's "agent" mode — the actual code path a workspace-summary
 * question takes (see useAskTabDump's doc) — so `/api/ai/ask` here returns a
 * single JSON body, not a text stream. Renders the REAL AskTabDumpPanel →
 * useAskTabDump → askQuestion chain; only `fetch` is mocked, in the exact
 * shape route.ts's real "agent" mode returns.
 */
describe("AskTabDumpPanel — agent-mode workspace summary (real hook, mocked fetch)", () => {
  const CATEGORIES: { name: string; titles: string[] }[] = [
    { name: "Physics", titles: ["General relativity and the equivalence principle", "Orbital mechanics of binary star systems", "Introduction to quantum field theory", "Gravitational wave detection with LIGO", "Special relativity: a geometric approach", "Thermodynamics of black holes", "Notes on Lagrangian mechanics", "Electromagnetic wave propagation in vacuum"] },
    { name: "Machine Learning", titles: ["Attention is all you need", "A survey of transformer architectures", "Reinforcement learning from human feedback", "Scaling laws for neural language models", "Diffusion models for image generation", "Efficient fine-tuning with LoRA", "Interpretability in large language models"] },
    { name: "Web Development", titles: ["vercel/next.js: The React framework", "How to structure a Next.js App Router project", "Understanding React Server Components", "TypeScript generics deep dive", "TailwindCSS v4 upgrade guide", "Building accessible modals from scratch", "Vitest vs Jest: a practical comparison"] },
    { name: "Cooking", titles: ["The science of a perfect sear", "Homemade pasta dough, step by step", "Fermentation basics for beginners", "How to properly season a cast iron pan", "Sourdough starter troubleshooting guide"] },
    { name: "Travel", titles: ["Two weeks in the Japanese Alps", "Budget guide to Southeast Asia", "Hiking the Dolomites: route planning", "Iceland ring road itinerary", "Best time to visit Patagonia"] },
    { name: "News & Current Events", titles: ["Global semiconductor supply chain update", "Climate policy negotiations enter final week", "Central banks weigh next rate decision", "New satellite constellation launched", "Regional elections: what changed", "Explainer: the latest trade agreement"] },
    { name: "Shopping", titles: ["Mechanical keyboard — hot-swappable switches", "Standing desk converter, dual monitor", "Noise-cancelling headphones comparison", "Ergonomic office chair reviews", "USB-C docking station"] },
    { name: "Miscellaneous", titles: ["History of the printing press", "The Antikythera mechanism", "Timeline of programming languages", "Great Library of Alexandria", "Byzantine Empire administrative reforms", "History of double-entry bookkeeping", "The Voynich manuscript", "Longitude problem and John Harrison", "History of the metric system", "Origins of the scientific method"] },
  ];

  function build53TabGeneralWorkspace(): Workspace {
    const tabs: Tab[] = [];
    let n = 0;
    for (const cat of CATEGORIES) {
      for (const title of cat.titles) {
        n += 1;
        const url = `https://example.com/article-${n}`;
        tabs.push({ id: `tab-${n}`, url, normalizedUrl: url, domain: "example.com", title, category: cat.name.toLowerCase() });
      }
    }
    if (tabs.length !== 53) throw new Error(`fixture drift: expected 53 tabs, built ${tabs.length}`);
    return { id: "ws-general", name: "General", tabs, createdAt: 0, updatedAt: 0 };
  }

  function buildFullSummaryText(workspace: Workspace): string {
    const sections = CATEGORIES.map((cat) => `### ${cat.name}\n\n${cat.titles.map((t) => `- ${t}`).join("\n")}`);
    return (
      `Here's a summary of your ${workspace.tabs.length} saved tabs in **${workspace.name}**, grouped by topic:\n\n` +
      sections.join("\n\n") +
      `\n\nOverall, this workspace leans heavily toward physics and machine learning research.`
    );
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function mockAgentFetch(askResponseBody: unknown) {
    return vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) return jsonResponse({ embeddings: [[1, 0, 0]] });
      if (url.includes("/api/ai/ask")) return jsonResponse(askResponseBody);
      throw new Error(`Unexpected fetch to ${url}`);
    });
  }

  it("renders the complete 53-tab summary verbatim, with no cut-off text and no truncation notice", async () => {
    const workspace = build53TabGeneralWorkspace();
    const fullSummary = buildFullSummaryText(workspace);
    mockAgentFetch({ text: fullSummary, actions: [] });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={workspace.id}
        tabs={workspace.tabs}
        indexState={noIndexing}
        allWorkspaces={[workspace]}
        onStoreUpdate={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );

    await user.type(screen.getByPlaceholderText(/ask anything/i), "Summarize this workspace");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Every category heading and every one of the 53 tab titles rendered,
    // in the actual DOM — not just present in some intermediate state.
    await waitFor(() => expect(screen.getByText(/Overall, this workspace leans/)).toBeTruthy());
    for (const cat of CATEGORIES) {
      expect(screen.getByText(new RegExp(`### ${cat.name}`))).toBeTruthy();
      for (const title of cat.titles) {
        expect(screen.getByText(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
      }
    }

    const rendered = screen.getByText(/Here's a summary of your 53 saved tabs/).textContent ?? "";
    expect(rendered).not.toMatch(/cut off/i);
    // Ends on the real closing sentence, not a dangling Markdown token.
    expect(rendered.trim().endsWith("research.")).toBe(true);
  });

  it("renders the truncation notice (and preserves the cut-off text) when the agent response was flagged truncated by MAX_TOKENS", async () => {
    const workspace = build53TabGeneralWorkspace();
    const fullSummary = buildFullSummaryText(workspace);
    const cutOff = fullSummary.slice(0, Math.floor(fullSummary.length * 0.4));
    // This is exactly what runAgentLoop's withTruncationNotice() produces —
    // the same text the real server route would return for a MAX_TOKENS turn.
    const textWithNotice = `${cutOff}\n\n_(That answer got cut off — it reached the model's response limit. Try asking about a narrower group of tabs.)_`;
    mockAgentFetch({ text: textWithNotice, actions: [] });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={workspace.id}
        tabs={workspace.tabs}
        indexState={noIndexing}
        allWorkspaces={[workspace]}
        onStoreUpdate={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );

    await user.type(screen.getByPlaceholderText(/ask anything/i), "Summarize this workspace");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(/cut off/i)).toBeTruthy());
    const rendered = screen.getByText(/cut off/i).textContent ?? "";
    // The user sees an honest notice, not the raw cut-off Markdown presented
    // as if it were a complete, successful answer.
    expect(rendered).toContain(cutOff);
    expect(rendered).toMatch(/cut off/i);
  });

  it("renders an ordinary short agent answer unchanged, with no truncation notice", async () => {
    const quickTab: Tab = { id: "q1", url: "https://example.com/q1", normalizedUrl: "https://example.com/q1", domain: "example.com", title: "A quick note" };
    const workspace: Workspace = { id: "ws-quick", name: "Quick Notes", tabs: [quickTab], createdAt: 0, updatedAt: 0 };
    mockAgentFetch({ text: "You have 1 tab saved: A quick note.", actions: [] });

    const user = userEvent.setup();
    render(
      <AskTabDumpPanel
        open
        workspaceId={workspace.id}
        tabs={workspace.tabs}
        indexState={noIndexing}
        allWorkspaces={[workspace]}
        onStoreUpdate={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );

    await user.type(screen.getByPlaceholderText(/ask anything/i), "Summarize this workspace");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("You have 1 tab saved: A quick note.")).toBeTruthy());
    expect(screen.queryByText(/cut off/i)).toBeNull();
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askQuestion, applyPlan, applyOrganizationPlan } from "./ask";
import type { OrganizationPlan } from "@/lib/organize/types";
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

it("routes through the agent endpoint and applies a returned store when `store` is given", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const mutatedStore = { ...workspaceStore, workspaces: [{ ...workspaceStore.workspaces[0], name: "Physics IA" }] };

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Renamed it.", actions: [], store: mutatedStore }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const tabs: Tab[] = [];
  const onStoreUpdate = vi.fn();

  const result = await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs,
    question: "Rename this workspace to Physics IA",
    history: [],
    store: workspaceStore,
    onStoreUpdate,
  });

  expect(result).toEqual({ ok: true, text: "Renamed it.", sources: expect.any(Array) });
  expect(onStoreUpdate).toHaveBeenCalledWith(mutatedStore, "Renamed it.");
  expect((capturedBody as unknown as { mode: string }).mode).toBe("agent");
  expect((capturedBody as unknown as { store: unknown }).store).toEqual(workspaceStore);
});

it("does not call onStoreUpdate when the agent response has no store (read-only turn)", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };

  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      return new Response(JSON.stringify({ text: "You have one workspace.", actions: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const onStoreUpdate = vi.fn();
  const result = await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs: [],
    question: "How many workspaces do I have?",
    history: [],
    store: workspaceStore,
    onStoreUpdate,
  });

  expect(result).toEqual({ ok: true, text: "You have one workspace.", sources: expect.any(Array) });
  expect(onStoreUpdate).not.toHaveBeenCalled();
});

it("returns a preview result (no store update) when the agent asks for confirmation", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const plan = [{ name: "move_tabs", args: { tabIds: ["1"], targetWorkspaceId: "ws-repro" }, label: 'Move 1 tab → "Physics"', affected: 1 }];

  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      return new Response(
        JSON.stringify({ requiresConfirmation: true, text: "Here's what I want to change", plan, summary: "This will move 1 tab." }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const onStoreUpdate = vi.fn();
  const result = await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs: [],
    question: "Organize this workspace",
    history: [],
    store: workspaceStore,
    onStoreUpdate,
  });

  expect(result).toEqual({
    ok: true,
    requiresConfirmation: true,
    text: "Here's what I want to change",
    plan,
    summary: "This will move 1 tab.",
  });
  expect(onStoreUpdate).not.toHaveBeenCalled();
});

it("applyPlan posts the exact plan and store, and applies the returned store", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const mutatedStore = { ...workspaceStore, workspaces: [{ ...workspaceStore.workspaces[0], groups: [{ id: "g1", name: "Midterms", createdAt: 0, updatedAt: 0 }] }] };
  const plan = [{ name: "create_group", args: { workspaceId: "ws-repro", name: "Midterms" }, label: 'Create group → "Midterms"', affected: 1 }];

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Done — created 1 group.", actions: [], store: mutatedStore }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const onStoreUpdate = vi.fn();
  const result = await applyPlan({ plan, store: workspaceStore, onStoreUpdate });

  expect(result).toEqual({ ok: true, text: "Done — created 1 group." });
  expect(onStoreUpdate).toHaveBeenCalledWith(mutatedStore, "Done — created 1 group.");
  expect((capturedBody as unknown as { mode: string }).mode).toBe("agent-apply");
  expect((capturedBody as unknown as { plan: unknown }).plan).toEqual([{ name: "create_group", args: plan[0].args }]);
  expect((capturedBody as unknown as { store: unknown }).store).toEqual(workspaceStore);
});

it("askQuestion includes browserContext in the request body and surfaces returned actions", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const browserContext = { tabs: [], windows: [], activeTabId: null };
  const actions = [{ name: "open_tabs", ok: true, message: "opened", args: { urls: ["https://a.com"] }, data: { urlCount: 1, urls: ["https://a.com"] } }];

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Opened it.", actions }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const result = await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs: [],
    question: "Open my Physics tab",
    history: [],
    store: workspaceStore,
    browserContext,
  });

  expect((capturedBody as unknown as { browserContext: unknown }).browserContext).toEqual(browserContext);
  expect(result.ok && (result as { text: string }).text).toBe("Opened it.");
  expect(result.ok && (result as { actions?: unknown }).actions).toEqual(actions);
});

it("applyPlan includes browserContext in the request body and surfaces returned actions", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const plan = [{ name: "open_tabs", args: { urls: ["https://a.com"] }, label: "Open 1 tab", affected: 1 }];
  const browserContext = { tabs: [], windows: [], activeTabId: null };
  const actions = [{ name: "open_tabs", ok: true, message: "opened", args: { urls: ["https://a.com"] }, data: { urlCount: 1, urls: ["https://a.com"] } }];

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Done — opened 1 tab.", actions }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const result = await applyPlan({ plan, store: workspaceStore, browserContext });

  expect((capturedBody as unknown as { browserContext: unknown }).browserContext).toEqual(browserContext);
  expect(result).toEqual({ ok: true, text: "Done — opened 1 tab.", actions });
});

it("computes semantic hints across every workspace in the store, not just the current one", async () => {
  const otherWorkspaceId = "ws-other";
  await putChunks([
    {
      key: `${otherWorkspaceId}:tab-2:summary`,
      workspaceId: otherWorkspaceId,
      tabId: "tab-2",
      kind: "summary",
      text: "Other workspace summary",
      embedding: [1, 0, 0],
      tabSignature: "sig",
      title: "Other",
      url: "https://example.com/b",
      indexedAt: Date.now(),
    },
  ]);

  const workspaceStore = {
    version: 1 as const,
    currentId: WORKSPACE_ID,
    workspaces: [
      { id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 },
      { id: otherWorkspaceId, name: "Research", tabs: [], createdAt: 0, updatedAt: 0 },
    ],
  };

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) {
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    }
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Found them.", actions: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  await askQuestion({ workspaceId: WORKSPACE_ID, tabs: [], question: "Find everything about X", history: [], store: workspaceStore });

  const semanticHints = (capturedBody as unknown as { semanticHints: { tabId: string; workspaceId: string }[] }).semanticHints;
  expect(semanticHints.map((h) => h.workspaceId).sort()).toEqual([WORKSPACE_ID, otherWorkspaceId].sort());
  // Never a raw vector on the wire.
  expect(JSON.stringify(semanticHints)).not.toContain("embedding");
});

it("forwards recentSearchResults so a follow-up like 'move those' can resolve without re-searching", async () => {
  const workspaceStore = { version: 1 as const, currentId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const priorResults = [
    { tabId: "t1", title: "Physics IA notes", url: "https://x.com", domain: "x.com", workspaceId: WORKSPACE_ID, workspaceName: "Physics", score: 4, matchReason: "title" as const },
  ];

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ text: "Moved them.", actions: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs: [],
    question: "Move those into Research",
    history: [],
    store: workspaceStore,
    recentSearchResults: priorResults,
  });

  expect((capturedBody as unknown as { recentSearchResults: unknown }).recentSearchResults).toEqual(priorResults);
});

it("surfaces searchResults returned by the agent on the AskResult", async () => {
  const workspaceStore = { version: 1 as const, currentId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const searchResults = [
    { tabId: "t1", title: "Physics IA notes", url: "https://x.com", domain: "x.com", workspaceId: WORKSPACE_ID, workspaceName: "Physics", score: 4, matchReason: "title" as const },
  ];

  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) {
      return new Response(JSON.stringify({ text: "I found 1 relevant tab.", actions: [], searchResults }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const result = await askQuestion({ workspaceId: WORKSPACE_ID, tabs: [], question: "Find my physics tabs", history: [], store: workspaceStore });

  expect(result).toEqual({ ok: true, text: "I found 1 relevant tab.", sources: expect.any(Array), searchResults });
});

it("still reaches the agent for an action request even when the current workspace has nothing indexed yet", async () => {
  const emptyWorkspaceId = "ws-brand-new";
  const workspaceStore = { version: 1 as const, currentId: emptyWorkspaceId, workspaces: [{ id: emptyWorkspaceId, name: "New", tabs: [], createdAt: 0, updatedAt: 0 }] };

  let agentCalled = false;
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) {
      agentCalled = true;
      return new Response(JSON.stringify({ text: "Renamed it.", actions: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const result = await askQuestion({
    workspaceId: emptyWorkspaceId,
    tabs: [],
    question: "Rename this workspace to Chemistry",
    history: [],
    store: workspaceStore,
  });

  expect(agentCalled).toBe(true);
  expect(result).toEqual({ ok: true, text: "Renamed it.", sources: [] });
});

describe("embedding-service unavailability (regression: agent actions must not be blocked by it)", () => {
  it("still reaches the agent — and list_workspaces still executes — when the embedding fetch rejects outright", async () => {
    const workspaceStore = { version: 1 as const, currentId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };

    let capturedBody: Record<string, unknown> | null = null;
    let agentCalled = false;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) throw new TypeError("Failed to fetch");
      if (url.includes("/api/ai/ask")) {
        agentCalled = true;
        capturedBody = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify({ text: "You have 1 workspace: Physics.", actions: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const result = await askQuestion({
      workspaceId: WORKSPACE_ID,
      tabs: [],
      question: "list my workspaces",
      history: [],
      store: workspaceStore,
    });

    expect(agentCalled).toBe(true);
    expect(result).toEqual({ ok: true, text: "You have 1 workspace: Physics.", sources: [] });
    // Nothing was fabricated in place of the failed embedding — retrieval and
    // hint-computation were skipped outright rather than run against a fake vector.
    expect((capturedBody as unknown as { context: unknown[] }).context).toEqual([]);
    expect((capturedBody as unknown as { semanticHints: unknown[] }).semanticHints).toEqual([]);
    expect((capturedBody as unknown as { semanticSearchDegraded: boolean }).semanticSearchDegraded).toBe(true);
  });

  it("does not fabricate semantic results for a semantic-search request when the embedding fetch rejects — degradation is passed through honestly instead", async () => {
    const workspaceStore = { version: 1 as const, currentId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };

    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) throw new TypeError("Failed to fetch");
      if (url.includes("/api/ai/ask")) {
        capturedBody = JSON.parse((init as RequestInit).body as string);
        return new Response(
          JSON.stringify({ text: "Semantic search is temporarily unavailable, so I could only match by keyword.", actions: [] }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const result = await askQuestion({
      workspaceId: WORKSPACE_ID,
      tabs: [],
      question: "find tabs about machine learning",
      history: [],
      store: workspaceStore,
    });

    expect(result.ok).toBe(true);
    // The one seeded chunk (see beforeEach) has a real embedding and would
    // normally score against the query — but with no query embedding to score
    // against, retrieval must come back empty, never populated with a
    // fabricated or best-guess match.
    expect(result.ok && !("organizePlan" in result) && !("requiresConfirmation" in result) && result.sources).toEqual([]);
    expect((capturedBody as unknown as { semanticHints: unknown[] }).semanticHints).toEqual([]);
    expect((capturedBody as unknown as { semanticSearchDegraded: boolean }).semanticSearchDegraded).toBe(true);
  });

  it("plain grounded Q&A (no store) still fails honestly, with the underlying error, when the embedding fetch rejects", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) throw new TypeError("Failed to fetch");
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const result = await askQuestion({ workspaceId: WORKSPACE_ID, tabs: [], question: "What did I save about X?", history: [] });

    expect(result).toEqual({ ok: false, error: "Couldn't reach the embedding service. (Failed to fetch)" });
  });

  it("agent mode is unaffected — semantic hints/context are computed normally — when the embedding fetch succeeds", async () => {
    const workspaceStore = { version: 1 as const, currentId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };

    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
      if (url.includes("/api/ai/ask")) {
        capturedBody = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify({ text: "Found it.", actions: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    await askQuestion({ workspaceId: WORKSPACE_ID, tabs: [], question: "find tabs about machine learning", history: [], store: workspaceStore });

    expect((capturedBody as unknown as { semanticSearchDegraded?: boolean }).semanticSearchDegraded).toBeUndefined();
    expect((capturedBody as unknown as { context: unknown[] }).context.length).toBeGreaterThan(0);
  });
});

it("applyPlan surfaces a server error without calling onStoreUpdate", async () => {
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Something failed." }), { status: 500 }));

  const onStoreUpdate = vi.fn();
  const result = await applyPlan({
    plan: [{ name: "create_group", args: {}, label: "x", affected: 1 }],
    store: { version: 1, currentId: "a", workspaces: [{ id: "a", name: "A", tabs: [], createdAt: 0, updatedAt: 0 }] },
    onStoreUpdate,
  });

  expect(result).toEqual({ ok: false, error: expect.stringContaining("Something failed.") });
  expect(onStoreUpdate).not.toHaveBeenCalled();
});

it("askQuestion returns an organizePlan result when the agent endpoint proposes one", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Inbox", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const organizePlan: OrganizationPlan = {
    summary: "I analyzed 5 tabs and found 1 useful cluster.",
    workspaces: [{ proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }] }],
    uncertainTabs: [],
    duplicates: [],
    totalTabsConsidered: 5,
  };

  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("/api/ai/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
    if (url.includes("/api/ai/ask")) return new Response(JSON.stringify({ text: organizePlan.summary, organizePlan }), { status: 200 });
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const result = await askQuestion({
    workspaceId: WORKSPACE_ID,
    tabs: [],
    question: "Organize my tabs",
    history: [],
    store: workspaceStore,
  });

  expect(result).toEqual({ ok: true, organizePlan, text: organizePlan.summary });
});

it("applyOrganizationPlan posts mode 'agent-organize-apply' and applies the returned store", async () => {
  const workspaceStore = { version: 1 as const, currentId: "ws-repro", workspaces: [{ id: "ws-repro", name: "Inbox", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const mutatedStore = { ...workspaceStore, workspaces: [...workspaceStore.workspaces, { id: "ws-new", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 }] };
  const organizePlan: OrganizationPlan = {
    summary: "s",
    workspaces: [{ proposedName: "Physics", reason: "r", tabs: [] }],
    uncertainTabs: [],
    duplicates: [],
    totalTabsConsidered: 0,
  };

  let capturedBody: Record<string, unknown> | null = null;
  vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({ text: "Organized 0 tabs into 1 workspace.", actions: [], store: mutatedStore }), { status: 200 });
  });

  const onStoreUpdate = vi.fn();
  const result = await applyOrganizationPlan({ organizationPlan: organizePlan, store: workspaceStore, onStoreUpdate });

  expect(result).toEqual({ ok: true, text: "Organized 0 tabs into 1 workspace." });
  expect(onStoreUpdate).toHaveBeenCalledWith(mutatedStore, "Organized 0 tabs into 1 workspace.");
  expect((capturedBody as unknown as { mode: string }).mode).toBe("agent-organize-apply");
  expect((capturedBody as unknown as { organizationPlan: unknown }).organizationPlan).toEqual(organizePlan);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { Tab } from "@/lib/tabs/types";

/**
 * Final end-to-end verification of the TabDump workspace-summary flow after
 * the MAX_TOKENS truncation fix (see src/lib/ai/gemini/client.ts's
 * `truncated` flag and src/lib/actions/agent.ts's withTruncationNotice()).
 *
 * Deliberately does NOT mock @/lib/ai/gemini/client or @/lib/actions/agent —
 * only the network boundary (global.fetch) is faked, in Gemini's real wire
 * shape. Everything above that — route.ts's POST handler, runAgentLoop,
 * generateAgentTurn, and the real action layer running against a real
 * 53-tab store — is the genuine production code path. There's no Gemini API
 * key configured in this environment, so this is as close to a real
 * end-to-end run as is possible here; see the verification report for what
 * that constraint does and doesn't prove.
 */

const originalFetch = global.fetch;

function geminiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const CATEGORIES: { name: string; domain: string; titles: string[] }[] = [
  {
    name: "Physics",
    domain: "arxiv.org",
    titles: [
      "General relativity and the equivalence principle",
      "Orbital mechanics of binary star systems",
      "Introduction to quantum field theory",
      "Gravitational wave detection with LIGO",
      "Special relativity: a geometric approach",
      "Thermodynamics of black holes",
      "Notes on Lagrangian mechanics",
      "Electromagnetic wave propagation in vacuum",
    ],
  },
  {
    name: "Machine Learning",
    domain: "arxiv.org",
    titles: [
      "Attention is all you need",
      "A survey of transformer architectures",
      "Reinforcement learning from human feedback",
      "Scaling laws for neural language models",
      "Diffusion models for image generation",
      "Efficient fine-tuning with LoRA",
      "Interpretability in large language models",
    ],
  },
  {
    name: "Web Development",
    domain: "github.com",
    titles: [
      "vercel/next.js: The React framework",
      "How to structure a Next.js App Router project",
      "Understanding React Server Components",
      "TypeScript generics deep dive",
      "TailwindCSS v4 upgrade guide",
      "Building accessible modals from scratch",
      "Vitest vs Jest: a practical comparison",
    ],
  },
  {
    name: "Cooking",
    domain: "seriouseats.com",
    titles: [
      "The science of a perfect sear",
      "Homemade pasta dough, step by step",
      "Fermentation basics for beginners",
      "How to properly season a cast iron pan",
      "Sourdough starter troubleshooting guide",
    ],
  },
  {
    name: "Travel",
    domain: "wikitravel.org",
    titles: [
      "Two weeks in the Japanese Alps",
      "Budget guide to Southeast Asia",
      "Hiking the Dolomites: route planning",
      "Iceland ring road itinerary",
      "Best time to visit Patagonia",
    ],
  },
  {
    name: "News & Current Events",
    domain: "reuters.com",
    titles: [
      "Global semiconductor supply chain update",
      "Climate policy negotiations enter final week",
      "Central banks weigh next rate decision",
      "New satellite constellation launched",
      "Regional elections: what changed",
      "Explainer: the latest trade agreement",
    ],
  },
  {
    name: "Shopping",
    domain: "amazon.com",
    titles: [
      "Mechanical keyboard — hot-swappable switches",
      "Standing desk converter, dual monitor",
      "Noise-cancelling headphones comparison",
      "Ergonomic office chair reviews",
      "USB-C docking station",
    ],
  },
  {
    name: "Miscellaneous",
    domain: "wikipedia.org",
    titles: [
      "History of the printing press",
      "The Antikythera mechanism",
      "Timeline of programming languages",
      "Great Library of Alexandria",
      "Byzantine Empire administrative reforms",
      "History of double-entry bookkeeping",
      "The Voynich manuscript",
      "Longitude problem and John Harrison",
      "History of the metric system",
      "Origins of the scientific method",
    ],
  },
];

function buildGeneralWorkspace(): Workspace {
  const tabs: Tab[] = [];
  let n = 0;
  for (const cat of CATEGORIES) {
    for (const title of cat.titles) {
      n += 1;
      const id = `tab-${n}`;
      const url = `https://${cat.domain}/article-${n}`;
      tabs.push({
        id,
        url,
        normalizedUrl: url,
        domain: cat.domain,
        title,
        category: cat.name.toLowerCase(),
      });
    }
  }
  // Sanity check on the fixture itself — the reported bug was specifically
  // about a ~53-tab workspace.
  if (tabs.length !== 53) throw new Error(`fixture drift: expected 53 tabs, built ${tabs.length}`);
  return { id: "ws-general", name: "General", tabs, createdAt: 0, updatedAt: 0 };
}

function buildStore(): WorkspaceStore {
  const general = buildGeneralWorkspace();
  return { version: 1, currentId: general.id, workspaces: [general] };
}

/** A realistic categorized Markdown summary referencing every one of the 53 tabs, close in size to what Gemini would actually produce for this workspace. */
function buildFullSummaryText(workspace: Workspace): string {
  const sections = CATEGORIES.map((cat) => {
    const bullets = cat.titles.map((t) => `- ${t}`).join("\n");
    return `### ${cat.name}\n\n${bullets}`;
  });
  return (
    `Here's a summary of your ${workspace.tabs.length} saved tabs in **${workspace.name}**, grouped by topic:\n\n` +
    sections.join("\n\n") +
    `\n\nOverall, this workspace leans heavily toward physics and machine learning research, with a solid cluster of web development references and a grab-bag of history, travel, cooking, and shopping tabs rounding it out.`
  );
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/ai/ask", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("Ask TabDump workspace-summary flow — real end-to-end (network boundary only mocked)", () => {
  it("1-4: uses the agent (non-streaming) path, requests 4096 output tokens, and returns the complete 53-tab summary uncut", async () => {
    const store = buildStore();
    const workspace = store.workspaces[0];
    const fullSummary = buildFullSummaryText(workspace);

    const fetchMock = vi.fn();
    // Turn 1: the model enumerates the workspace's tabs before summarizing —
    // deliberately WITHOUT an explicit `limit`, the common case for a model
    // that hasn't specifically reasoned about page size. This is what
    // actually exercises the fix: it proves the raised default alone (not a
    // limit the mock happens to supply) is what gets all 53 tabs back in
    // one call — see src/lib/actions/read.ts's list_workspace_tabs.
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "list_workspace_tabs", args: { workspaceId: workspace.id } } }],
            },
            finishReason: "STOP",
          },
        ],
      })
    );
    // Turn 2: the model's final natural-language summary, comfortably under
    // the 4096-token budget (this fixture's full text is ~1900 characters —
    // well under half of what the OLD 1024-token/~4000-char cap allowed,
    // and far under the new cap, so a real Gemini call would finish with
    // finishReason: "STOP", not "MAX_TOKENS").
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [{ content: { parts: [{ text: fullSummary }] }, finishReason: "STOP" }],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({
        mode: "agent",
        question: "Summarize this workspace",
        history: [],
        context: [],
        store,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };

    // (1) Agent path, not the streaming chat path: exactly two non-streaming
    // generateContent calls were made (no streamGenerateContent call, no
    // Response with a ReadableStream body was ever constructed for this).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const url = call[0] as string;
      expect(url).toContain(":generateContent");
      expect(url).not.toContain("streamGenerateContent");
    }

    // (2) Gemini received the increased 4096-token budget on BOTH turns of
    // this agent loop, not the old 1024 constant.
    for (const call of fetchMock.mock.calls) {
      const requestBody = JSON.parse((call[1] as RequestInit).body as string);
      expect(requestBody.generationConfig.maxOutputTokens).toBe(4096);
    }

    // The tool call actually ran against the real 53-tab store (real action
    // layer, not mocked) — confirms the model saw every tab, not a stale or
    // partial snapshot.
    const secondRequestBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const toolResultTurn = secondRequestBody.contents.find((c: { parts: Array<{ functionResponse?: unknown }> }) =>
      c.parts.some((p) => "functionResponse" in p)
    );
    const toolResult = toolResultTurn.parts[0].functionResponse.response.result;
    expect(toolResult.total).toBe(53);
    expect(toolResult.tabs).toHaveLength(53);
    expect(toolResult.truncated).toBe(false);
    expect(toolResult.nextOffset).toBeUndefined();
    expect(toolResult.note).toBeUndefined();

    // (3) & (4): the returned text is the complete summary, byte-for-byte —
    // not cut off, no truncation notice appended.
    expect(body.text).toBe(fullSummary);
    expect(body.text).not.toMatch(/cut off/i);

    // (6)/(7): every category heading and every one of the 53 tab titles
    // made it into the final text — nothing dropped mid-generation, no
    // dangling/unclosed Markdown token at the end of the response.
    for (const cat of CATEGORIES) {
      expect(body.text).toContain(`### ${cat.name}`);
      for (const title of cat.titles) expect(body.text).toContain(title);
    }
    // The response ends on a real sentence, not a truncated token.
    expect(body.text.trim().endsWith(".")).toBe(true);
    expect(body.text.trim().endsWith("#")).toBe(false);
    expect(body.text.trim().endsWith("*")).toBe(false);
  });

  it("8: detects finishReason MAX_TOKENS on a response long enough to exceed even the raised budget, and surfaces the truncation notice instead of silently showing a cut-off summary", async () => {
    const store = buildStore();
    const workspace = store.workspaces[0];
    const fullSummary = buildFullSummaryText(workspace);
    // Simulate Gemini running out of its (still finite) output budget partway
    // through the same summary — cut mid-bullet, mid-word, the way the
    // original bug report described ("stops partway through").
    const cutOffSummary = fullSummary.slice(0, Math.floor(fullSummary.length * 0.4));

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "list_workspace_tabs", args: { workspaceId: workspace.id } } }] },
            finishReason: "STOP",
          },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [{ content: { parts: [{ text: cutOffSummary }] }, finishReason: "MAX_TOKENS" }],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ mode: "agent", question: "Summarize this workspace", history: [], context: [], store })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };

    // The cut-off text is preserved verbatim (never discarded)...
    expect(body.text.startsWith(cutOffSummary)).toBe(true);
    // ...but the user is told honestly that it was cut off, rather than the
    // truncated Markdown being presented as if it were the complete answer.
    expect(body.text).toMatch(/cut off/i);
  });

  it("ordinary shorter agent responses (no tool calls, well under the token budget) are returned unchanged", async () => {
    const store: WorkspaceStore = {
      version: 1,
      currentId: "ws-1",
      workspaces: [{ id: "ws-1", name: "Quick Notes", tabs: [], createdAt: 0, updatedAt: 0 }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      geminiResponse({
        candidates: [{ content: { parts: [{ text: "You don't have any tabs saved in this workspace yet." }] }, finishReason: "STOP" }],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ mode: "agent", question: "Summarize this workspace", history: [], context: [], store })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };
    expect(body.text).toBe("You don't have any tabs saved in this workspace yet.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(requestBody.generationConfig.maxOutputTokens).toBe(4096);
  });

  /**
   * Latency regression: a workspace under the 100-tab default page size
   * needs exactly ONE list_workspace_tabs call to see everything, and (per
   * the preamble fix in route.ts) shouldn't need a list_workspaces call at
   * all — the current workspace's id is already given directly. Verifies
   * both facts against the real agent loop with a real 60-tab store (the
   * exact tab count from the reported latency bug), not just that the mocked
   * model's own choices happen to look right.
   */
  it("a 60-tab workspace summary needs exactly one list_workspace_tabs call and no list_workspaces call", async () => {
    const tabs: Tab[] = [];
    for (let i = 1; i <= 60; i++) {
      const url = `https://example.com/article-${i}`;
      tabs.push({ id: `tab-${i}`, url, normalizedUrl: url, domain: "example.com", title: `Article ${i}` });
    }
    const workspace: Workspace = { id: "ws-60", name: "Main", tabs, createdAt: 0, updatedAt: 0 };
    const store: WorkspaceStore = { version: 1, currentId: workspace.id, workspaces: [workspace] };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [
          { content: { parts: [{ functionCall: { name: "list_workspace_tabs", args: { workspaceId: workspace.id } } }] }, finishReason: "STOP" },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [{ content: { parts: [{ text: "Summarized all 60 tabs." }] }, finishReason: "STOP" }],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { POST } = await import("./route");
    const response = await POST(postRequest({ mode: "agent", question: "Summarize this workspace", history: [], context: [], store }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };
    expect(body.text).toBe("Summarized all 60 tabs.");

    // Exactly two model round trips: one tool call, one final answer — no
    // extra list_workspaces lookup, no second list_workspace_tabs page.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequestBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const preambleText = firstRequestBody.contents[firstRequestBody.contents.length - 1].parts[0].text as string;
    expect(preambleText).toMatch(/already have its id.*no need to call list_workspaces/i);

    const secondRequestBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const toolTurn = secondRequestBody.contents.find((c: { parts: Array<{ functionResponse?: unknown }> }) => c.parts.some((p) => "functionResponse" in p));
    const pageResult = toolTurn.parts[0].functionResponse.response.result;
    expect(pageResult.tabs).toHaveLength(60);
    expect(pageResult.truncated).toBe(false);
  });

  /**
   * Regression coverage for the follow-up fix to list_workspace_tabs's
   * 50-tab default (see src/lib/actions/read.ts). A raised default alone
   * only helps workspaces that fit under it — this proves a workspace
   * LARGER than the default page size still gets summarized completely,
   * by driving the real pagination protocol (`truncated`/`nextOffset`) end
   * to end through the real action layer: a model that follows
   * AGENT_SYSTEM_INSTRUCTION's pagination guidance (route.ts) keeps calling
   * list_workspace_tabs with `offset: nextOffset` until `truncated` is
   * false, then — and only then — writes its summary.
   */
  it("a workspace larger than the default page size is summarized in full via list_workspace_tabs pagination, not silently truncated at the page boundary", async () => {
    const perCategory = 17; // 8 categories × 17 = 136 tabs — bigger than the 100-tab default page
    const categoryNames = ["Physics", "History", "Cooking", "Travel", "Music", "Sports", "Art", "Finance"];
    const tabs: Tab[] = [];
    let n = 0;
    for (const cat of categoryNames) {
      for (let i = 1; i <= perCategory; i++) {
        n += 1;
        const url = `https://example.com/${cat.toLowerCase()}-${i}`;
        tabs.push({ id: `tab-${n}`, url, normalizedUrl: url, domain: "example.com", title: `${cat} article ${i}`, category: cat.toLowerCase() });
      }
    }
    const workspace: Workspace = { id: "ws-big", name: "Everything", tabs, createdAt: 0, updatedAt: 0 };
    const store: WorkspaceStore = { version: 1, currentId: workspace.id, workspaces: [workspace] };
    expect(workspace.tabs.length).toBe(136);

    const fetchMock = vi.fn();
    // Turn 1: first page — no offset yet.
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [
          { content: { parts: [{ functionCall: { name: "list_workspace_tabs", args: { workspaceId: workspace.id } } }] }, finishReason: "STOP" },
        ],
      })
    );
    // Turn 2: the model reads the first page's `truncated`/`nextOffset` and
    // pages again — this is the exact continuation call
    // AGENT_SYSTEM_INSTRUCTION now asks for, not something the test harness
    // forces on it.
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const toolTurn = body.contents.find((c: { parts: Array<{ functionResponse?: unknown }> }) => c.parts.some((p) => "functionResponse" in p));
      const firstPage = toolTurn.parts[0].functionResponse.response.result;
      expect(firstPage.truncated).toBe(true);
      expect(firstPage.nextOffset).toBeDefined();
      return geminiResponse({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "list_workspace_tabs", args: { workspaceId: workspace.id, offset: firstPage.nextOffset } } }] },
            finishReason: "STOP",
          },
        ],
      });
    });
    // Turn 3: final summary — only reached once the model has paged through
    // everything (asserted below via the total tab count referenced).
    fetchMock.mockResolvedValueOnce(
      geminiResponse({
        candidates: [{ content: { parts: [{ text: `Summarized all ${workspace.tabs.length} tabs across ${categoryNames.length} categories.` }] }, finishReason: "STOP" }],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { POST } = await import("./route");
    const response = await POST(postRequest({ mode: "agent", question: "Summarize all my saved tabs", history: [], context: [], store }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(body.text).toBe("Summarized all 136 tabs across 8 categories.");

    // Directly verify the two tool calls together covered every tab exactly
    // once, in order — not just that the model claims 136 in prose.
    const secondRequestBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const firstToolTurn = secondRequestBody.contents.find((c: { parts: Array<{ functionResponse?: unknown }> }) => c.parts.some((p) => "functionResponse" in p));
    const firstPageResult = firstToolTurn.parts[0].functionResponse.response.result;

    const thirdRequestBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    const toolTurns = thirdRequestBody.contents.filter((c: { parts: Array<{ functionResponse?: unknown }> }) => c.parts.some((p) => "functionResponse" in p));
    const secondPageResult = toolTurns[toolTurns.length - 1].parts[0].functionResponse.response.result;

    expect(firstPageResult.tabs).toHaveLength(100);
    expect(secondPageResult.tabs).toHaveLength(36);
    expect(secondPageResult.truncated).toBe(false);
    const allIds = [...firstPageResult.tabs, ...secondPageResult.tabs].map((t: { tabId: string }) => t.tabId);
    expect(allIds).toEqual(tabs.map((t) => t.id));
    expect(new Set(allIds).size).toBe(136);
  });
});

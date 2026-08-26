import { afterEach, describe, expect, it, vi } from "vitest";

const generateContentMock = vi.hoisted(() => vi.fn());
const generateContentStreamMock = vi.hoisted(() => vi.fn());
const runAgentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/gemini/client", () => ({
  generateContent: generateContentMock,
  generateContentStream: generateContentStreamMock,
}));

vi.mock("@/lib/actions/agent", () => ({
  runAgentLoop: runAgentLoopMock,
}));

const { POST } = await import("./route");
const { __clearServerCacheForTests } = await import("@/lib/ai/server/cache");
const { __clearRateLimitsForTests } = await import("@/lib/ai/server/rate-limit");

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/ai/ask", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const validContext = [{ tabId: "t1", title: "Title", url: "https://example.com", text: "some text" }];

const validStore = {
  version: 1,
  currentId: "ws-1",
  workspaces: [
    { id: "ws-1", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 },
  ],
};

afterEach(() => {
  generateContentMock.mockReset();
  generateContentStreamMock.mockReset();
  runAgentLoopMock.mockReset();
  // The analysis-result cache and per-IP rate limiter are process-wide
  // singletons (see src/lib/ai/server) — without resetting them: (1) an
  // earlier collection-overview/gaps test's cached result would silently
  // short-circuit a later test reusing the same question+context instead of
  // exercising its own mock, and (2) this file's many sequential requests
  // (all from the same "unknown" test-request IP) would trip the rate
  // limiter partway through and start failing unrelated later tests.
  __clearServerCacheForTests();
  __clearRateLimitsForTests();
});

describe("POST /api/ai/ask", () => {
  it("returns 400 for malformed JSON", async () => {
    expect((await POST(postRequest("{not json"))).status).toBe(400);
  });

  it("returns 400 for an empty question", async () => {
    const response = await POST(postRequest({ question: "  ", context: [] }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid mode", async () => {
    const response = await POST(postRequest({ question: "hi", context: [], mode: "not-a-mode" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a malformed context array", async () => {
    const response = await POST(postRequest({ question: "hi", context: [{ tabId: "t1" }] }));
    expect(response.status).toBe(400);
  });

  it("streams the chat response as plain text", async () => {
    generateContentStreamMock.mockResolvedValue({ ok: true, data: textStream("Hello from Gemini") });

    const response = await POST(postRequest({ question: "What did I save?", context: validContext }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toBe("Hello from Gemini");
  });

  it("maps a chat streaming failure to its status code and surfaces the detail", async () => {
    generateContentStreamMock.mockResolvedValue({ ok: false, reason: "gemini-error", detail: "Invalid argument.", status: 400 });
    const response = await POST(postRequest({ question: "hi", context: validContext }));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.detail).toBe("Invalid argument.");
  });

  /**
   * Regression test for a real bug: a question longer than the old 500-char
   * MAX_QUESTION_CHARS got silently sliced before ever reaching Gemini, and
   * Gemini then correctly (if confusingly) told the user their own query
   * "was cut off" — which read like a hallucination but was actually an
   * honest description of what this route had already done to their input.
   * Long, with a distinctive marker at the very end so any truncation
   * (accidental re-introduction of a low cap, an off-by-one, etc.) is
   * unmistakable rather than silently passing on a coincidentally-short slice.
   */
  it("sends the full user question to Gemini uncut, even a long one", async () => {
    generateContentStreamMock.mockResolvedValue({ ok: true, data: textStream("ok") });
    const endMarker = "END-OF-QUERY-MARKER-7f3a9c";
    const longQuestion = `Summarize what I've saved about ${"astrophysics, orbital mechanics, and general relativity ".repeat(15)}${endMarker}`;
    expect(longQuestion.length).toBeGreaterThan(500);

    await POST(postRequest({ question: longQuestion, context: validContext }));

    const contents = generateContentStreamMock.mock.calls[0][0].contents;
    const userTurn = contents[contents.length - 1];
    expect(userTurn.text).toContain(longQuestion);
    expect(userTurn.text.trim().endsWith(endMarker)).toBe(true);
  });

  it("sends Gemini's UPPERCASE Type enum in the collection-overview responseSchema", async () => {
    generateContentMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ overview: "o", themes: [], importantResourceIndexes: [], keyInsights: [] }),
    });

    await POST(postRequest({ question: "Summarize", context: validContext, mode: "collection-overview" }));

    const schema = generateContentMock.mock.calls[0][0].responseSchema;
    expect(schema.type).toBe("OBJECT");
    expect(schema.properties.overview.type).toBe("STRING");
    expect(schema.properties.themes.items.type).toBe("STRING");
    expect(schema.properties.importantResourceIndexes.items.type).toBe("INTEGER");
  });

  it("returns structured JSON for collection-overview mode", async () => {
    generateContentMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ overview: "o", themes: ["a"], importantResourceIndexes: [1], keyInsights: ["i"] }),
    });

    const response = await POST(
      postRequest({ question: "Summarize", context: validContext, mode: "collection-overview" })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.overview).toBe("o");
    expect(body.result.importantResourceIndexes).toEqual([1]);
  });

  it("returns 502 when the model's JSON output can't be parsed", async () => {
    generateContentMock.mockResolvedValue({ ok: true, data: "not json" });
    const response = await POST(
      postRequest({ question: "Summarize", context: validContext, mode: "collection-gaps" })
    );
    expect(response.status).toBe(502);
  });

  it("maps a 429 from Gemini to a graceful 429 response, not a crash", async () => {
    generateContentMock.mockResolvedValue({ ok: false, reason: "rate-limited", status: 429 });
    const response = await POST(postRequest({ question: "Summarize", context: validContext, mode: "collection-overview" }));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe("Too many requests right now — try again shortly.");
  });

  it("maps a Gemini timeout to a graceful 504 response", async () => {
    generateContentMock.mockResolvedValue({ ok: false, reason: "timeout" });
    const response = await POST(postRequest({ question: "Summarize", context: validContext, mode: "collection-gaps" }));
    expect(response.status).toBe(504);
  });

  it("maps a raw network failure to a graceful 502, not a crash", async () => {
    generateContentMock.mockResolvedValue({ ok: false, reason: "network-error", detail: "fetch failed" });
    const response = await POST(postRequest({ question: "Summarize", context: validContext, mode: "collection-overview" }));
    expect(response.status).toBe(502);
  });

  it("maps an unavailable/unknown model response from Gemini to a graceful 502 carrying Gemini's own detail", async () => {
    generateContentMock.mockResolvedValue({ ok: false, reason: "gemini-error", detail: "model not found", status: 404 });
    const response = await POST(postRequest({ question: "Summarize", context: validContext, mode: "collection-gaps" }));
    expect(response.status).toBe(502);
    expect((await response.json()).detail).toBe("model not found");
  });

  describe("collection analysis caching", () => {
    it("cached AI result reuse: re-running the same analysis on an unchanged tab set never calls Gemini twice", async () => {
      generateContentMock.mockResolvedValue({
        ok: true,
        data: JSON.stringify({ overview: "o", themes: [], importantResourceIndexes: [], keyInsights: [] }),
      });

      const first = await POST(postRequest({ question: "Summarize this collection", context: validContext, mode: "collection-overview" }));
      expect(first.status).toBe(200);
      expect(generateContentMock).toHaveBeenCalledTimes(1);

      generateContentMock.mockClear();
      const second = await POST(postRequest({ question: "Summarize this collection", context: validContext, mode: "collection-overview" }));

      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(generateContentMock).not.toHaveBeenCalled();
    });

    it("concurrent identical collection-analysis requests are coalesced into one Gemini call", async () => {
      let resolveGenerate!: (v: { ok: true; data: string }) => void;
      generateContentMock.mockReturnValue(new Promise((resolve) => { resolveGenerate = resolve; }));

      const p1 = POST(postRequest({ question: "Summarize this collection", context: validContext, mode: "collection-overview" }));
      const p2 = POST(postRequest({ question: "Summarize this collection", context: validContext, mode: "collection-overview" }));
      await vi.waitFor(() => expect(generateContentMock).toHaveBeenCalledTimes(1));

      resolveGenerate({ ok: true, data: JSON.stringify({ overview: "shared", themes: [], importantResourceIndexes: [], keyInsights: [] }) });
      const [r1, r2] = await Promise.all([p1, p2]);

      expect((await r1.json()).result.overview).toBe("shared");
      expect((await r2.json()).result.overview).toBe("shared");
    });

    it("a changed tab set (different context) is a cache miss, not a stale reuse", async () => {
      generateContentMock
        .mockResolvedValueOnce({ ok: true, data: JSON.stringify({ overview: "first", themes: [], importantResourceIndexes: [], keyInsights: [] }) })
        .mockResolvedValueOnce({ ok: true, data: JSON.stringify({ overview: "second", themes: [], importantResourceIndexes: [], keyInsights: [] }) });

      await POST(postRequest({ question: "Summarize this collection", context: validContext, mode: "collection-overview" }));
      const changedContext = [...validContext, { tabId: "t2", title: "Another", url: "https://example.com/2", text: "more text" }];
      const response = await POST(postRequest({ question: "Summarize this collection", context: changedContext, mode: "collection-overview" }));

      expect(generateContentMock).toHaveBeenCalledTimes(2);
      expect((await response.json()).result.overview).toBe("second");
    });
  });

  describe("agent mode", () => {
    it("returns 400 when store is missing or invalid", async () => {
      const response = await POST(
        postRequest({ question: "Move my tabs", context: validContext, mode: "agent" })
      );
      expect(response.status).toBe(400);
    });

    it("returns the agent's final text and reports actions performed", async () => {
      runAgentLoopMock.mockResolvedValue({
        ok: true,
        kind: "resolved",
        text: "Done — I moved 3 tabs into Physics.",
        store: validStore,
        storeChanged: false,
        actions: [{ name: "search_tabs", ok: true, message: "found 3" }],
      });

      const response = await POST(
        postRequest({ question: "Find my physics tabs", context: validContext, mode: "agent", store: validStore })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.text).toBe("Done — I moved 3 tabs into Physics.");
      expect(body.actions).toEqual([{ name: "search_tabs", ok: true, message: "found 3" }]);
      expect(body.store).toBeUndefined();
    });

    /**
     * Latency regression: measured directly against the real agent loop, the
     * model reliably called list_workspaces FIRST purely to re-derive the
     * current workspace's id — even though the preamble already states it —
     * costing a whole extra ~15-25s non-streaming round trip on ordinary
     * workspace-scoped questions. The preamble must say outright that the id
     * is already known, so the model doesn't spend a call looking it up
     * again (it can still call list_workspaces for a workspace the user
     * refers to by a DIFFERENT name — this only removes the pointless
     * self-lookup of the one it's already been given).
     */
    it("tells the model it already has the current workspace's id, to avoid a redundant list_workspaces round trip", async () => {
      runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

      await POST(postRequest({ question: "Summarize this workspace", context: [], mode: "agent", store: validStore }));

      const contents = runAgentLoopMock.mock.calls[0][0].contents;
      const userTurn = contents[contents.length - 1];
      const text = userTurn.parts[0].text as string;
      expect(text).toContain(`Current workspace: "Physics" (id: ws-1)`);
      expect(text).toMatch(/already have its id.*no need to call list_workspaces/i);
    });

    it("includes the mutated store in the response only when a write action changed it", async () => {
      const mutatedStore = { ...validStore, workspaces: [...validStore.workspaces, { id: "ws-2", name: "New", tabs: [], createdAt: 0, updatedAt: 0 }] };
      runAgentLoopMock.mockResolvedValue({
        ok: true,
        kind: "resolved",
        text: "Created the New workspace.",
        store: mutatedStore,
        storeChanged: true,
        actions: [{ name: "create_workspace", ok: true, message: "created" }],
      });

      const response = await POST(
        postRequest({ question: "Create a workspace called New", context: [], mode: "agent", store: validStore })
      );

      const body = await response.json();
      expect(body.store).toEqual(mutatedStore);
    });

    it("passes the tool declarations through to Gemini so it can select the right one", async () => {
      runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

      await POST(postRequest({ question: "List my workspaces", context: [], mode: "agent", store: validStore }));

      expect(runAgentLoopMock).toHaveBeenCalledWith(
        expect.objectContaining({
          store: validStore,
          contents: expect.arrayContaining([
            expect.objectContaining({ role: "user", parts: [expect.objectContaining({ text: expect.stringContaining("List my workspaces") })] }),
          ]),
        })
      );
    });

    /** Same query-integrity regression as the chat-mode test above, for the agent path. */
    it("sends the full user question to the agent loop uncut, even a long one", async () => {
      runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });
      const endMarker = "END-OF-QUERY-MARKER-9b21e5";
      const longQuestion = `Summarize what I've saved about ${"TabDump development, my academics, and my projects ".repeat(15)}${endMarker}`;
      expect(longQuestion.length).toBeGreaterThan(500);

      await POST(postRequest({ question: longQuestion, context: [], mode: "agent", store: validStore }));

      const contents = runAgentLoopMock.mock.calls[0][0].contents;
      const userTurn = contents[contents.length - 1];
      const text = userTurn.parts[0].text as string;
      expect(text).toContain(longQuestion);
      expect(text.trim().endsWith(endMarker)).toBe(true);
    });

    it("maps a Gemini failure from the agent loop to its status code", async () => {
      runAgentLoopMock.mockResolvedValue({ ok: false, reason: "rate-limited", detail: "slow down" });

      const response = await POST(
        postRequest({ question: "hi", context: [], mode: "agent", store: validStore })
      );

      expect(response.status).toBe(429);
    });

    it("returns a structured preview instead of executing anything when the loop resolves to a preview", async () => {
      const plan = [
        { name: "create_group", args: { workspaceId: "ws-1", name: "References" }, label: 'Create group → "References"', affected: 1 },
      ];
      runAgentLoopMock.mockResolvedValue({
        ok: true,
        kind: "preview",
        text: "Here's what I want to change",
        plan,
        summary: "This will create 1 group.",
      });

      const response = await POST(
        postRequest({ question: "Organize this workspace", context: [], mode: "agent", store: validStore })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.requiresConfirmation).toBe(true);
      expect(body.plan).toEqual(plan);
      expect(body.summary).toBe("This will create 1 group.");
      expect(body.store).toBeUndefined();
      expect(body.actions).toBeUndefined();
    });

    it("returns organizePlan (not requiresConfirmation) when the loop resolves to an 'organize' result", async () => {
      const organizePlan = {
        summary: "I analyzed 5 tabs and found 1 useful cluster.",
        workspaces: [{ proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }] }],
        uncertainTabs: [],
        duplicates: [],
        totalTabsConsidered: 5,
      };
      runAgentLoopMock.mockResolvedValue({ ok: true, kind: "organize", text: organizePlan.summary, organizePlan });

      const response = await POST(postRequest({ question: "Organize my tabs", context: [], mode: "agent", store: validStore }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.organizePlan).toEqual(organizePlan);
      expect(body.text).toBe(organizePlan.summary);
      expect(body.requiresConfirmation).toBeUndefined();
    });

    it("returns 400 for a malformed semanticClusters payload", async () => {
      const response = await POST(
        postRequest({ question: "Organize my tabs", context: [], mode: "agent", store: validStore, semanticClusters: [{ tabId: "t1" }] })
      );
      expect(response.status).toBe(400);
    });

    it("passes semanticClusters through to runAgentLoop", async () => {
      runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });
      const semanticClusters = [{ tabId: "t1", clusterKey: "sem-0" }];

      await POST(postRequest({ question: "Organize my tabs", context: [], mode: "agent", store: validStore, semanticClusters }));

      expect(runAgentLoopMock).toHaveBeenCalledWith(expect.objectContaining({ semanticClusters }));
    });

    describe("global search", () => {
      const searchResults = [
        {
          tabId: "t1",
          title: "Schwarzschild solution vs Newtonian gravity",
          url: "https://github.com/x",
          domain: "github.com",
          workspaceId: "ws-1",
          workspaceName: "Physics IA",
          score: 4,
          matchReason: "title" as const,
        },
      ];

      it("returns 400 for a malformed semanticHints payload", async () => {
        const response = await POST(
          postRequest({
            question: "Find my physics tabs",
            context: [],
            mode: "agent",
            store: validStore,
            semanticHints: [{ tabId: "t1" }], // missing workspaceId/score
          })
        );
        expect(response.status).toBe(400);
      });

      it("passes semanticHints through to the agent loop, capped at MAX_SEMANTIC_HINTS", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });
        const manyHints = Array.from({ length: 80 }, (_, i) => ({ tabId: `t${i}`, workspaceId: "ws-1", score: 0.6 }));

        await POST(
          postRequest({ question: "Find my physics tabs", context: [], mode: "agent", store: validStore, semanticHints: manyHints })
        );

        const passedHints = runAgentLoopMock.mock.calls[0][0].semanticHints;
        expect(passedHints).toHaveLength(50);
        expect(passedHints[0]).toEqual({ tabId: "t0", workspaceId: "ws-1", score: 0.6 });
      });

      it("returns 400 for a malformed browserContext payload", async () => {
        const response = await POST(
          postRequest({
            question: "What tabs do I have open?",
            context: [],
            mode: "agent",
            store: validStore,
            browserContext: { tabs: "not an array", windows: [], activeTabId: null },
          })
        );
        expect(response.status).toBe(400);
      });

      it("passes a well-formed browserContext through to the agent loop", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });
        const browserContext = {
          tabs: [{ tabId: 1, windowId: 1, url: "https://a.com", title: "A", pinned: false, active: true, index: 0 }],
          windows: [{ windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [1] }],
          activeTabId: 1,
        };

        await POST(postRequest({ question: "What tabs do I have open?", context: [], mode: "agent", store: validStore, browserContext }));

        expect(runAgentLoopMock.mock.calls[0][0].browserContext).toEqual(browserContext);
      });

      it("omits browserContext from the agent loop call when the extension wasn't connected", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

        await POST(postRequest({ question: "hi", context: [], mode: "agent", store: validStore }));

        expect(runAgentLoopMock.mock.calls[0][0].browserContext).toBeUndefined();
      });

      it("returns 400 for a malformed recentSearchResults payload", async () => {
        const response = await POST(
          postRequest({
            question: "Move those into Research",
            context: [],
            mode: "agent",
            store: validStore,
            recentSearchResults: [{ tabId: "t1" }], // missing required fields
          })
        );
        expect(response.status).toBe(400);
      });

      it("injects recentSearchResults into the prompt sent to the agent loop", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

        await POST(
          postRequest({
            question: "Move those into Research",
            context: [],
            mode: "agent",
            store: validStore,
            recentSearchResults: searchResults,
          })
        );

        const contents = runAgentLoopMock.mock.calls[0][0].contents;
        const userTurn = contents[contents.length - 1];
        expect(userTurn.parts[0].text).toContain("Recent search results");
        expect(userTurn.parts[0].text).toContain("Schwarzschild solution vs Newtonian gravity");
        expect(userTurn.parts[0].text).toContain("t1");
      });

      it("includes searchResults in a resolved response when the agent loop found some", async () => {
        runAgentLoopMock.mockResolvedValue({
          ok: true,
          kind: "resolved",
          text: "I found 1 relevant tab.",
          store: validStore,
          storeChanged: false,
          actions: [],
          searchResults,
        });

        const response = await POST(
          postRequest({ question: "Find my physics tabs", context: [], mode: "agent", store: validStore })
        );

        const body = await response.json();
        expect(body.searchResults).toEqual(searchResults);
      });

      it("includes searchResults in a preview response too", async () => {
        runAgentLoopMock.mockResolvedValue({
          ok: true,
          kind: "preview",
          text: "Here's what I want to change",
          plan: [{ name: "move_tabs", args: {}, label: "Move 1 tab", affected: 1 }],
          summary: "This will move 1 tab.",
          searchResults,
        });

        const response = await POST(
          postRequest({ question: "Move those into Research", context: [], mode: "agent", store: validStore })
        );

        const body = await response.json();
        expect(body.searchResults).toEqual(searchResults);
      });

      it("omits searchResults entirely when the agent loop didn't search", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

        const response = await POST(postRequest({ question: "hi", context: [], mode: "agent", store: validStore }));

        const body = await response.json();
        expect(body.searchResults).toBeUndefined();
      });
    });

    describe("semanticSearchDegraded", () => {
      it("returns 400 when semanticSearchDegraded isn't a boolean", async () => {
        const response = await POST(
          postRequest({ question: "hi", context: [], mode: "agent", store: validStore, semanticSearchDegraded: "yes" })
        );
        expect(response.status).toBe(400);
      });

      it("reaches the agent loop for a pure action request even when semanticSearchDegraded is true", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "You have 1 workspace.", store: validStore, storeChanged: false, actions: [] });

        const response = await POST(
          postRequest({ question: "list my workspaces", context: [], mode: "agent", store: validStore, semanticSearchDegraded: true })
        );

        expect(response.status).toBe(200);
        expect(runAgentLoopMock).toHaveBeenCalled();
        const body = await response.json();
        expect(body.text).toBe("You have 1 workspace.");
      });

      it("adds a degradation note to the agent prompt when semanticSearchDegraded is true", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

        await POST(
          postRequest({ question: "find tabs about machine learning", context: [], mode: "agent", store: validStore, semanticSearchDegraded: true })
        );

        const contents = runAgentLoopMock.mock.calls[0][0].contents;
        const userTurn = contents[contents.length - 1];
        expect(userTurn.parts[0].text).toContain("Semantic (meaning-based) search is temporarily unavailable");
      });

      it("omits the degradation note from the agent prompt when semanticSearchDegraded is absent", async () => {
        runAgentLoopMock.mockResolvedValue({ ok: true, kind: "resolved", text: "ok", store: validStore, storeChanged: false, actions: [] });

        await POST(postRequest({ question: "find tabs about machine learning", context: [], mode: "agent", store: validStore }));

        const contents = runAgentLoopMock.mock.calls[0][0].contents;
        const userTurn = contents[contents.length - 1];
        expect(userTurn.parts[0].text).not.toContain("Semantic (meaning-based) search is temporarily unavailable");
      });
    });
  });

  describe("agent-apply mode", () => {
    it("returns 400 when store is missing or invalid", async () => {
      const response = await POST(
        postRequest({ mode: "agent-apply", plan: [{ name: "create_group", args: {} }] })
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when plan is missing or invalid", async () => {
      const response = await POST(postRequest({ mode: "agent-apply", store: validStore, plan: [] }));
      expect(response.status).toBe(400);
    });

    it("does not require a question, context, or Gemini call at all", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "create_group", args: { workspaceId: "ws-1", name: "References" } }],
        })
      );

      expect(response.status).toBe(200);
      expect(generateContentMock).not.toHaveBeenCalled();
      expect(generateContentStreamMock).not.toHaveBeenCalled();
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it("executes the plan for real and returns the mutated store plus a done message", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "create_group", args: { workspaceId: "ws-1", name: "References" } }],
        })
      );

      const body = await response.json();
      expect(body.text).toMatch(/^Done —/);
      expect(body.store.workspaces[0].groups[0].name).toBe("References");
      expect(body.actions).toEqual([{ name: "create_group", ok: true, message: expect.any(String) }]);
    });

    it("returns 400 for a malformed browserContext payload", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "open_tabs", args: { urls: ["https://a.com"] } }],
          browserContext: { tabs: [], windows: "nope", activeTabId: null },
        })
      );
      expect(response.status).toBe(400);
    });

    it("fails a browser write action when browserContext is omitted (extension not connected)", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "open_tabs", args: { urls: ["https://a.com"] } }],
        })
      );
      const body = await response.json();
      expect(body.actions).toEqual([{ name: "open_tabs", ok: false, message: expect.stringContaining("isn't connected") }]);
    });

    it("succeeds a browser write action when a valid browserContext is given", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "open_tabs", args: { urls: ["https://a.com"] } }],
          browserContext: { tabs: [], windows: [], activeTabId: null },
        })
      );
      const body = await response.json();
      expect(body.actions).toHaveLength(1);
      expect(body.actions[0]).toMatchObject({ name: "open_tabs", ok: true, args: { urls: ["https://a.com"] } });
    });

    it("revalidates and fails a step whose resource no longer exists, without pretending success", async () => {
      const response = await POST(
        postRequest({
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "move_tab", args: { tabId: "ghost", targetWorkspaceId: "ws-1" } }],
        })
      );

      const body = await response.json();
      expect(body.actions).toEqual([{ name: "move_tab", ok: false, message: expect.any(String) }]);
      expect(body.store).toBeUndefined();
      expect(body.text).not.toMatch(/^Done —/);
    });
  });

  describe("agent-organize-apply mode", () => {
    const storeWithTab = {
      version: 1,
      currentId: "ws-1",
      workspaces: [
        { id: "ws-1", name: "Inbox", tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", title: "Physics notes" }], createdAt: 0, updatedAt: 0 },
      ],
    };
    const validPlan = {
      summary: "s",
      workspaces: [{ proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }] }],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 1,
    };

    it("returns 400 when store is missing or invalid", async () => {
      const response = await POST(postRequest({ mode: "agent-organize-apply", organizationPlan: validPlan }));
      expect(response.status).toBe(400);
    });

    it("returns 400 when organizationPlan is missing or malformed", async () => {
      const response = await POST(postRequest({ mode: "agent-organize-apply", store: storeWithTab, organizationPlan: { summary: "s" } }));
      expect(response.status).toBe(400);
    });

    it("does not require a question, context, or Gemini call at all", async () => {
      const response = await POST(postRequest({ mode: "agent-organize-apply", store: storeWithTab, organizationPlan: validPlan }));

      expect(response.status).toBe(200);
      expect(generateContentMock).not.toHaveBeenCalled();
      expect(generateContentStreamMock).not.toHaveBeenCalled();
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it("creates the proposed workspace, moves the tab, and returns the mutated store as one operation", async () => {
      const response = await POST(postRequest({ mode: "agent-organize-apply", store: storeWithTab, organizationPlan: validPlan }));

      const body = await response.json();
      expect(body.text).toMatch(/^Organized 1 tab/);
      const physics = body.store.workspaces.find((w: { name: string }) => w.name === "Physics");
      expect(physics).toBeTruthy();
      expect(physics.tabs.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    });

    it("rejects an organization plan whose tab ids no longer exist in the current store", async () => {
      const stalePlan = {
        ...validPlan,
        workspaces: [{ proposedName: "Physics", reason: "r", tabs: [{ tabId: "ghost", reason: "r", confidence: "high" }] }],
      };

      const response = await POST(postRequest({ mode: "agent-organize-apply", store: storeWithTab, organizationPlan: stalePlan }));
      expect(response.status).toBe(400);
    });
  });

  describe("per-IP rate limiting", () => {
    function postFrom(ip: string, body: unknown): Request {
      return new Request("https://tabdump.example/api/ai/ask", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
      });
    }

    it("blocks further AI questions from one IP once its limit is hit, without calling Gemini for the blocked one — but never blocks Gemini-free modes", async () => {
      generateContentStreamMock.mockResolvedValue({ ok: true, data: textStream("ok") });

      for (let i = 0; i < 20; i++) {
        const response = await POST(postFrom("198.51.100.7", { question: `q${i}`, context: [] }));
        expect(response.status).toBe(200);
      }

      generateContentStreamMock.mockClear();
      const blocked = await POST(postFrom("198.51.100.7", { question: "one more", context: [] }));
      expect(blocked.status).toBe(429);
      expect(generateContentStreamMock).not.toHaveBeenCalled();

      // A user who's hit their AI-question limit can still do ordinary,
      // non-AI TabDump actions (applying an already-decided plan needs no
      // Gemini call at all) — the AI limit never blocks core functionality.
      const applyResponse = await POST(
        postFrom("198.51.100.7", {
          mode: "agent-apply",
          store: validStore,
          plan: [{ name: "create_group", args: { workspaceId: "ws-1", name: "References" } }],
        })
      );
      expect(applyResponse.status).toBe(200);
    });
  });
});

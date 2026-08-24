import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("embedTexts", () => {
  it("posts one request per text to batchEmbedContents and returns the values arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { embedTexts } = await import("./client");

    const result = await embedTexts(["a", "b"], "gemini-embedding-001");

    expect(result).toEqual({ ok: true, data: [[0.1, 0.2], [0.3, 0.4]] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.requests).toEqual([
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] } },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "b" }] } },
    ]);
  });

  it("surfaces Gemini's own error message as `detail` on a non-2xx response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: 400, message: "Invalid model name.", status: "INVALID_ARGUMENT" } })) as unknown as typeof fetch;
    const { embedTexts } = await import("./client");

    const result = await embedTexts(["a"], "not-a-real-model");

    expect(result).toEqual({ ok: false, reason: "gemini-error", detail: "Invalid model name.", status: 400 });
  });

  it("maps a 429 to rate-limited while still keeping the detail", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: { message: "Quota exceeded." } })) as unknown as typeof fetch;
    const { embedTexts } = await import("./client");

    const result = await embedTexts(["a"], "gemini-embedding-001");

    expect(result).toEqual({ ok: false, reason: "rate-limited", detail: "Quota exceeded.", status: 429 });
  });

  it("returns missing-key without ever calling fetch when no API key is configured", async () => {
    vi.unstubAllEnvs();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { embedTexts } = await import("./client");

    const result = await embedTexts(["a"], "gemini-embedding-001");

    expect(result).toEqual({ ok: false, reason: "missing-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures a network failure's message as detail", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    const { embedTexts } = await import("./client");

    const result = await embedTexts(["a"], "gemini-embedding-001");

    expect(result).toEqual({ ok: false, reason: "network-error", detail: "fetch failed" });
  });
});

describe("generateContent", () => {
  it("sends UPPERCASE-cased responseSchema through untouched and parses candidate text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { generateContent } = await import("./client");

    await generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", text: "hi" }],
      maxOutputTokens: 100,
      responseSchema: { type: "OBJECT", properties: { a: { type: "STRING" } } },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.responseSchema).toEqual({ type: "OBJECT", properties: { a: { type: "STRING" } } });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("returns gemini-error with detail on a non-2xx response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { message: "Internal error." } })) as unknown as typeof fetch;
    const { generateContent } = await import("./client");

    const result = await generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", text: "hi" }],
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: false, reason: "gemini-error", detail: "Internal error.", status: 500 });
  });
});

describe("generateAgentTurn", () => {
  const tools = [{ name: "list_workspaces", description: "List workspaces.", parameters: { type: "OBJECT", properties: {} } }];

  it("sends tools/toolConfig and parses a plain-text response with no function call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "Hello there" }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: true, data: { text: "Hello there", functionCalls: [] } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ functionDeclarations: tools }]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  /**
   * Latency fix regression: measured directly against the real API, Gemini 3
   * spends a real, non-trivial share of every non-streaming agent-turn
   * call's wall-clock time on internal "thinking" tokens the user never sees
   * (a single call was observed spending ~980 of ~1000 total tokens on
   * thinking alone). Deciding which tool to call, or writing a factual
   * summary already grounded in tool results, doesn't need deep reasoning —
   * thinkingLevel: "LOW" is the least this model allows (thinkingBudget: 0 is
   * rejected outright for Gemini 3, unlike Gemini 2.5).
   */
  it("requests the lowest available thinking level, to cut avoidable latency", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "Hello there" }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools,
      maxOutputTokens: 100,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  });

  it("parses a functionCall part into a structured function call", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          { content: { parts: [{ functionCall: { name: "list_workspaces", args: {} } }] } },
        ],
      })
    ) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "list my workspaces" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: true, data: { text: "", functionCalls: [{ name: "list_workspaces", args: {} }] } });
  });

  /**
   * Regression test for the production error: "Function call is missing a
   * thought_signature in functionCall parts... function call
   * default_api:list_workspaces". Gemini 3 attaches `thoughtSignature` as a
   * SIBLING of `functionCall` on the Part object (confirmed against
   * Google's Gemini 3 / thought-signatures docs), not as a property inside
   * `functionCall` itself — this asserts the parser actually reads it from
   * there rather than silently dropping it.
   */
  it("parses a functionCall part's sibling thoughtSignature field", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "list_workspaces", args: {} }, thoughtSignature: "SIG_LIST_WORKSPACES" }],
            },
          },
        ],
      })
    ) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "list my workspaces" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({
      ok: true,
      data: { text: "", functionCalls: [{ name: "list_workspaces", args: {}, thoughtSignature: "SIG_LIST_WORKSPACES" }] },
    });
  });

  /** Parallel calls: Gemini generally only signs the first Part in a batch — the parser must not invent one for the second. */
  it("parses parallel functionCall parts where only the first carries a thoughtSignature", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "list_workspaces", args: {} }, thoughtSignature: "SIG_A" },
                { functionCall: { name: "search_tabs", args: { query: "MUN" } } },
              ],
            },
          },
        ],
      })
    ) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "list workspaces and find MUN tabs" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        text: "",
        functionCalls: [
          { name: "list_workspaces", args: {}, thoughtSignature: "SIG_A" },
          { name: "search_tabs", args: { query: "MUN" } },
        ],
      },
    });
    // Not just "equal" (which treats an explicit `undefined` the same as absent) — the
    // second call must never even carry the key, since we never invent one.
    expect(Object.prototype.hasOwnProperty.call(result.ok ? result.data.functionCalls[1] : {}, "thoughtSignature")).toBe(false);
  });

  it("serializes a functionResponse part sent back to the model under role: 'user' — Gemini's contents schema has no 'function' role", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "Done." }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [
        { role: "user", parts: [{ text: "list my workspaces" }] },
        { role: "model", parts: [{ functionCall: { name: "list_workspaces", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "list_workspaces", response: { result: { workspaces: [] } } } }] },
      ],
      tools,
      maxOutputTokens: 100,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "list_workspaces", response: { result: { workspaces: [] } } } }],
    });
    // Regression: nothing in this request's contents ever carries the
    // Gemini-unsupported "function" role (see AgentContent's doc).
    expect(JSON.stringify(body.contents)).not.toContain('"role":"function"');
  });

  it("returns missing-key without calling fetch when no API key is configured", async () => {
    vi.unstubAllEnvs();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: false, reason: "missing-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns malformed-response when the candidate has no parts", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [{}] })) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: false, reason: "malformed-response", detail: "response had no candidate parts" });
  });

  /**
   * Regression test for a workspace-summary response that stopped partway
   * through with stray Markdown (e.g. an unclosed "**" or a dangling "###"
   * heading). A non-streaming generateContent call always returns a
   * complete, valid HTTP JSON envelope — MAX_TOKENS never corrupts that
   * envelope, it only cuts the `text` field off mid-thought inside it. This
   * is the exact wire shape Gemini returns in that case: candidate text
   * ending mid-sentence plus `finishReason: "MAX_TOKENS"`.
   */
  it("flags `truncated: true` when finishReason is MAX_TOKENS, without altering the (cut-off) text itself", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          {
            content: { parts: [{ text: "### 1. Research\n\n- Paper on orbital mechanics\n- Notes on general rel" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      })
    ) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "summarize this workspace" }] }],
      tools,
      maxOutputTokens: 1024,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        text: "### 1. Research\n\n- Paper on orbital mechanics\n- Notes on general rel",
        functionCalls: [],
        truncated: true,
      },
    });
  });

  it("omits `truncated` entirely (never `false`) when finishReason is a normal STOP", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "All done." }] }, finishReason: "STOP" }],
      })
    ) as unknown as typeof fetch;
    const { generateAgentTurn } = await import("./client");

    const result = await generateAgentTurn({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools,
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ ok: true, data: { text: "All done.", functionCalls: [] } });
    expect(Object.prototype.hasOwnProperty.call(result.ok ? result.data : {}, "truncated")).toBe(false);
  });
});

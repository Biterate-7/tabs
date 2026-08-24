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
});

import { afterEach, describe, expect, it, vi } from "vitest";

const generateContentMock = vi.hoisted(() => vi.fn());
const generateContentStreamMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/gemini/client", () => ({
  generateContent: generateContentMock,
  generateContentStream: generateContentStreamMock,
}));

const { POST } = await import("./route");

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

afterEach(() => {
  generateContentMock.mockReset();
  generateContentStreamMock.mockReset();
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

  it("maps a chat streaming failure to its status code", async () => {
    generateContentStreamMock.mockResolvedValue({ ok: false, reason: "missing-key" });
    const response = await POST(postRequest({ question: "hi", context: validContext }));
    expect(response.status).toBe(503);
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
});

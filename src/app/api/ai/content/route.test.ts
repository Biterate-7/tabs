import { afterEach, describe, expect, it, vi } from "vitest";

const extractPageContentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/extract-text", () => ({
  extractPageContent: extractPageContentMock,
}));

const { POST } = await import("./route");

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/ai/content", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  extractPageContentMock.mockReset();
});

describe("POST /api/ai/content", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await POST(postRequest("{not json"));
    expect(response.status).toBe(400);
  });

  it("returns 400 when urls is missing or not a string array", async () => {
    expect((await POST(postRequest({}))).status).toBe(400);
    expect((await POST(postRequest({ urls: [1, 2] }))).status).toBe(400);
  });

  it("extracts content for each URL and returns one result per input", async () => {
    extractPageContentMock.mockImplementation(async (url: string) =>
      url.includes("ok") ? { description: "desc", text: "body text" } : null
    );

    const response = await POST(
      postRequest({ urls: ["https://ok.example", "https://fails.example"] })
    );
    const body = await response.json();
    expect(body.results).toEqual([
      { url: "https://ok.example", ok: true, description: "desc", text: "body text" },
      { url: "https://fails.example", ok: false },
    ]);
  });

  it("rejects unsafe URLs before ever calling extraction", async () => {
    const response = await POST(postRequest({ urls: ["http://127.0.0.1/admin"] }));
    const body = await response.json();
    expect(body.results).toEqual([{ url: "http://127.0.0.1/admin", ok: false }]);
    expect(extractPageContentMock).not.toHaveBeenCalled();
  });

  it("truncates batches larger than the max instead of rejecting them", async () => {
    extractPageContentMock.mockResolvedValue({ text: "t" });
    const urls = Array.from({ length: 30 }, (_, i) => `https://example.com/${i}`);
    const response = await POST(postRequest({ urls }));
    const body = await response.json();
    expect(body.results).toHaveLength(20);
  });
});

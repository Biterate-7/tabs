import { afterEach, describe, expect, it, vi } from "vitest";

const embedTextsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/gemini/client", () => ({
  embedTexts: embedTextsMock,
}));

const { POST } = await import("./route");

function postRequest(body: unknown): Request {
  return new Request("https://tabdump.example/api/ai/embed", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  embedTextsMock.mockReset();
});

describe("POST /api/ai/embed", () => {
  it("returns 400 for malformed JSON", async () => {
    expect((await POST(postRequest("{not json"))).status).toBe(400);
  });

  it("returns 400 for an empty or missing texts array", async () => {
    expect((await POST(postRequest({}))).status).toBe(400);
    expect((await POST(postRequest({ texts: [] }))).status).toBe(400);
  });

  it("returns 400 when texts exceeds the max batch size", async () => {
    const response = await POST(postRequest({ texts: Array.from({ length: 101 }, () => "x") }));
    expect(response.status).toBe(400);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("returns embeddings on success", async () => {
    embedTextsMock.mockResolvedValue({ ok: true, data: [[0.1, 0.2]] });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embeddings: [[0.1, 0.2]] });
  });

  it("maps a missing-key failure to a 503 with a clean message", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "missing-key" });
    const response = await POST(postRequest({ texts: ["hello"] }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("AI features aren't configured yet.");
  });

  it("maps a rate-limited failure to a 429", async () => {
    embedTextsMock.mockResolvedValue({ ok: false, reason: "rate-limited" });
    expect((await POST(postRequest({ texts: ["hello"] }))).status).toBe(429);
  });
});

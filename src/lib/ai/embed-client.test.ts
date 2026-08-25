import { afterEach, expect, it, vi } from "vitest";
import { embedTexts } from "./embed-client";

afterEach(() => {
  vi.restoreAllMocks();
});

it("returns embeddings on a successful response", async () => {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 })
  );

  const result = await embedTexts(["hello"]);

  expect(result).toEqual({ ok: true, embeddings: [[0.1, 0.2, 0.3]] });
});

it("includes the underlying error when the fetch itself rejects (network failure)", async () => {
  vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

  const result = await embedTexts(["hello"]);

  expect(result).toEqual({ ok: false, error: "Couldn't reach the embedding service. (Failed to fetch)" });
});

it("falls back to the generic message when the rejection carries no message", async () => {
  vi.spyOn(global, "fetch").mockRejectedValue("not an Error instance");

  const result = await embedTexts(["hello"]);

  expect(result).toEqual({ ok: false, error: "Couldn't reach the embedding service." });
});

it("formats an HTTP error response via formatApiError, distinct from a network failure", async () => {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "AI features aren't configured yet.", detail: "missing key" }), { status: 503 })
  );

  const result = await embedTexts(["hello"]);

  expect(result).toEqual({ ok: false, error: "AI features aren't configured yet. (missing key)" });
});

it("reports a malformed 200 response distinctly from both network and HTTP errors", async () => {
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }));

  const result = await embedTexts(["hello"]);

  expect(result).toEqual({ ok: false, error: "Malformed embedding response." });
});

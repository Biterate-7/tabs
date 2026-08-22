import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateContentStream } from "./client";

function sseFrame(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
}

/**
 * A ReadableStream whose chunks/close are scheduled at absolute ms offsets,
 * driven by whatever timer implementation (real or fake) is active. When
 * `signal` is given, aborting it errors the stream — matching what a real
 * aborted fetch does to its response body (the mocked `fetch` below doesn't
 * get this for free, since it isn't a real network implementation).
 */
function scheduledStream(
  events: Array<{ atMs: number; text?: string; close?: boolean }>,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      ctrl.error(signal.reason);
    } catch {
      // Already closed/errored — nothing to do.
    }
  });
  for (const ev of events) {
    setTimeout(() => {
      if (signal?.aborted) return;
      if (ev.close) ctrl.close();
      else if (ev.text) ctrl.enqueue(encoder.encode(sseFrame(ev.text)));
    }, ev.atMs);
  }
  return stream;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("does not abort a healthy stream whose TOTAL duration exceeds 30s, as long as chunks keep arriving within the 30s inactivity window", async () => {
  // 5 chunks, 20s apart — 100s total (well past the 30s window), but every
  // individual gap is under it. This is exactly the scenario the previous
  // AbortSignal.timeout(30000) bug killed incorrectly.
  const body = scheduledStream([
    { atMs: 20000, text: "chunk0 " },
    { atMs: 40000, text: "chunk1 " },
    { atMs: 60000, text: "chunk2 " },
    { atMs: 80000, text: "chunk3 " },
    { atMs: 100000, close: true },
  ]);
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

  const resultPromise = generateContentStream({
    model: "gemini-3.6-flash",
    contents: [{ role: "user", text: "hi" }],
    maxOutputTokens: 10,
  });
  await vi.advanceTimersByTimeAsync(0);
  const result = await resultPromise;
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const readPromise = readAll(result.data);
  await vi.advanceTimersByTimeAsync(100000);
  const text = await readPromise;
  expect(text).toBe("chunk0 chunk1 chunk2 chunk3 ");
});

it("aborts and errors the stream when the connection genuinely goes silent past the inactivity window", async () => {
  // One chunk, then 35s of silence (over the 30s window) before another
  // chunk that should never actually be delivered.
  vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const signal = (init as RequestInit)?.signal ?? undefined;
    const body = scheduledStream(
      [
        { atMs: 1000, text: "chunk0 " },
        { atMs: 36000, text: "chunk1 " },
        { atMs: 37000, close: true },
      ],
      signal
    );
    return new Response(body, { status: 200 });
  });

  const resultPromise = generateContentStream({
    model: "gemini-3.6-flash",
    contents: [{ role: "user", text: "hi" }],
    maxOutputTokens: 10,
  });
  await vi.advanceTimersByTimeAsync(0);
  const result = await resultPromise;
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const readPromise = readAll(result.data).catch((err) => ({ errored: true, message: err?.message }));
  await vi.advanceTimersByTimeAsync(40000);
  const outcome = await readPromise;
  expect(outcome).toMatchObject({ errored: true });
  expect((outcome as { message: string }).message).toMatch(/stopped sending data/);
});

it("returns a timeout result (not a raw network-error) when Gemini never responds within the connect window", async () => {
  vi.spyOn(global, "fetch").mockImplementation((_url, init) => {
    const signal = (init as RequestInit).signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  });

  const resultPromise = generateContentStream({
    model: "gemini-3.6-flash",
    contents: [{ role: "user", text: "hi" }],
    maxOutputTokens: 10,
  });
  await vi.advanceTimersByTimeAsync(30000);
  const result = await resultPromise;

  expect(result).toMatchObject({ ok: false, reason: "timeout" });
});

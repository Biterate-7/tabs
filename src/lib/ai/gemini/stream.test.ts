import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateContentStream } from "./client";

function sseFrame(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("delivers full text with no hang when SSE frames arrive as one clean chunk per frame", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(sseFrame("Hello ")));
      controller.enqueue(encoder.encode(sseFrame("world")));
      controller.enqueue(encoder.encode(sseFrame(".")));
      controller.close();
    },
  });
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

  const result = await Promise.race([
    generateContentStream({ model: "gemini-3.6-flash", contents: [{ role: "user", text: "hi" }], maxOutputTokens: 10 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
  ]);
  expect((result as { ok: boolean }).ok).toBe(true);

  const text = await Promise.race([
    readAll((result as { ok: true; data: ReadableStream<Uint8Array> }).data),
    new Promise((_, reject) => setTimeout(() => reject(new Error("readAll hung")), 3000)),
  ]);
  expect(text).toBe("Hello world.");
});

it("delivers full text with no hang when a single SSE frame's bytes are split across multiple network chunks", async () => {
  const frame = sseFrame("split frame content");
  // Split the raw bytes of ONE frame roughly in half — simulating TCP/HTTP
  // chunking cutting a `data: {...}\n\n` line in the middle, which is
  // completely normal and must not lose or hang on that frame.
  const bytes = new TextEncoder().encode(frame);
  const mid = Math.floor(bytes.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

  const result = await generateContentStream({ model: "gemini-3.6-flash", contents: [{ role: "user", text: "hi" }], maxOutputTokens: 10 });
  expect(result.ok).toBe(true);

  const text = await Promise.race([
    readAll((result as { ok: true; data: ReadableStream<Uint8Array> }).data),
    new Promise((_, reject) => setTimeout(() => reject(new Error("readAll hung")), 3000)),
  ]);
  expect(text).toBe("split frame content");
});

it("does not silently drop the final frame when the stream closes right after it, with no trailing newline", async () => {
  const encoder = new TextEncoder();
  // Real-world case: the very last `data: ...` line arrives and the
  // connection closes without ever sending the second trailing "\n" —
  // this frame must still be flushed, not stuck in the internal buffer.
  const lastFrameNoTrailingNewline = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "final chunk" }] } }] })}`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseFrame("first ")));
      controller.enqueue(encoder.encode(lastFrameNoTrailingNewline));
      controller.close();
    },
  });
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

  const result = await generateContentStream({ model: "gemini-3.6-flash", contents: [{ role: "user", text: "hi" }], maxOutputTokens: 10 });
  expect(result.ok).toBe(true);

  const text = await Promise.race([
    readAll((result as { ok: true; data: ReadableStream<Uint8Array> }).data),
    new Promise((_, reject) => setTimeout(() => reject(new Error("readAll hung")), 3000)),
  ]);
  expect(text).toBe("first final chunk");
});

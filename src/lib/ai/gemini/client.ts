import "server-only";
import { geminiApiKey, hasGeminiKey } from "@/lib/ai/config";
import type { GeminiContent, GeminiResult, GenerateOptions } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_TIMEOUT_MS = 10000;
const GENERATE_TIMEOUT_MS = 30000;
const MAX_EMBED_BATCH = 100;

function toGeminiFailure(status: number): "rate-limited" | "gemini-error" {
  return status === 429 ? "rate-limited" : "gemini-error";
}

function toContents(contents: GeminiContent[]) {
  return contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] }));
}

/**
 * Embeds up to MAX_EMBED_BATCH texts in one request via batchEmbedContents.
 * Callers are responsible for chunking larger batches — this never splits
 * internally so the caller's own concurrency limiter stays in control.
 */
export async function embedTexts(
  texts: string[],
  model: string
): Promise<GeminiResult<number[][]>> {
  if (!hasGeminiKey()) return { ok: false, reason: "missing-key" };
  if (texts.length === 0) return { ok: true, data: [] };
  if (texts.length > MAX_EMBED_BATCH) {
    return { ok: false, reason: "malformed-response" };
  }

  const url = `${API_BASE}/models/${model}:batchEmbedContents`;
  const body = {
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    })),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": geminiApiKey()!,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network-error" };
  }

  if (!response.ok) return { ok: false, reason: toGeminiFailure(response.status) };

  try {
    const data = await response.json();
    const embeddings = data?.embeddings;
    if (!Array.isArray(embeddings)) return { ok: false, reason: "malformed-response" };
    const vectors = embeddings.map((e: { values?: unknown }) =>
      Array.isArray(e?.values) ? (e.values as number[]) : null
    );
    if (vectors.some((v: number[] | null) => v === null)) {
      return { ok: false, reason: "malformed-response" };
    }
    return { ok: true, data: vectors as number[][] };
  } catch {
    return { ok: false, reason: "malformed-response" };
  }
}

/** Non-streaming generation — used for structured (JSON) collection analysis. */
export async function generateContent(opts: GenerateOptions): Promise<GeminiResult<string>> {
  if (!hasGeminiKey()) return { ok: false, reason: "missing-key" };

  const url = `${API_BASE}/models/${opts.model}:generateContent`;
  const body = buildRequestBody(opts);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": geminiApiKey()!,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network-error" };
  }

  if (!response.ok) return { ok: false, reason: toGeminiFailure(response.status) };

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
    if (typeof text !== "string") return { ok: false, reason: "malformed-response" };
    return { ok: true, data: text };
  } catch {
    return { ok: false, reason: "malformed-response" };
  }
}

/**
 * Streaming generation — used for chat. Returns a ReadableStream of plain
 * UTF-8 text deltas (SSE framing from the upstream response already parsed
 * away), so the Route Handler can pipe it straight through to the browser.
 */
export async function generateContentStream(
  opts: GenerateOptions
): Promise<GeminiResult<ReadableStream<Uint8Array>>> {
  if (!hasGeminiKey()) return { ok: false, reason: "missing-key" };

  const url = `${API_BASE}/models/${opts.model}:streamGenerateContent?alt=sse`;
  const body = buildRequestBody(opts);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": geminiApiKey()!,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network-error" };
  }

  if (!response.ok || !response.body) return { ok: false, reason: toGeminiFailure(response.status) };

  return { ok: true, data: toTextDeltaStream(response.body) };
}

function buildRequestBody(opts: GenerateOptions) {
  return {
    contents: toContents(opts.contents),
    ...(opts.systemInstruction
      ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
      : {}),
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens,
      ...(opts.responseSchema
        ? { responseMimeType: "application/json", responseSchema: opts.responseSchema }
        : {}),
    },
  };
}

/** Parses `data: {...}` SSE lines from Gemini's stream into plain text chunks. */
function toTextDeltaStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          const text = parsed?.candidates?.[0]?.content?.parts
            ?.map((p: { text?: string }) => p.text ?? "")
            .join("");
          if (text) controller.enqueue(encoder.encode(text));
        } catch {
          // Ignore a single malformed SSE frame rather than aborting the
          // whole stream — the next frame is independent.
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

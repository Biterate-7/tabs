import "server-only";
import { geminiApiKey, hasGeminiKey } from "@/lib/ai/config";
import type { GeminiContent, GeminiResult, GenerateOptions } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_TIMEOUT_MS = 10000;
const GENERATE_TIMEOUT_MS = 30000;
const MAX_EMBED_BATCH = 100;

const MAX_LOGGED_DETAIL_CHARS = 500;

function toGeminiFailure(status: number): "rate-limited" | "gemini-error" {
  return status === 429 ? "rate-limited" : "gemini-error";
}

function toContents(contents: GeminiContent[]) {
  return contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] }));
}

/**
 * Extracts Gemini's own error message from a failed response — Google's
 * standard API error shape is `{"error": {"code", "message", "status"}}`.
 * Never touches request headers/body, so this can never echo back our own
 * API key; it only ever relays what Gemini itself said was wrong.
 */
async function readErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message) {
      return message.slice(0, MAX_LOGGED_DETAIL_CHARS);
    }
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return raw.slice(0, MAX_LOGGED_DETAIL_CHARS);
}

/**
 * Logs the real failure server-side (Vercel Function Logs) so it's
 * diagnosable without ever putting Gemini's response — or our key — in
 * front of the browser. `op` identifies which call failed (embed/generate/
 * generateStream) since all three share this one log line shape.
 */
function logGeminiFailure(op: string, status: number | undefined, detail: string): void {
  console.error(`[gemini:${op}] request failed${status ? ` (HTTP ${status})` : ""}: ${detail || "(no detail)"}`);
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown network error";
    logGeminiFailure("embed", undefined, detail);
    return { ok: false, reason: "network-error", detail };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    logGeminiFailure("embed", response.status, detail);
    return { ok: false, reason: toGeminiFailure(response.status), detail, status: response.status };
  }

  try {
    const data = await response.json();
    const embeddings = data?.embeddings;
    if (!Array.isArray(embeddings)) return { ok: false, reason: "malformed-response", detail: "response had no `embeddings` array" };
    const vectors = embeddings.map((e: { values?: unknown }) =>
      Array.isArray(e?.values) ? (e.values as number[]) : null
    );
    if (vectors.some((v: number[] | null) => v === null)) {
      return { ok: false, reason: "malformed-response", detail: "an embedding entry was missing `values`" };
    }
    return { ok: true, data: vectors as number[][] };
  } catch (err) {
    return { ok: false, reason: "malformed-response", detail: err instanceof Error ? err.message : "couldn't parse response JSON" };
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown network error";
    logGeminiFailure("generate", undefined, detail);
    return { ok: false, reason: "network-error", detail };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    logGeminiFailure("generate", response.status, detail);
    return { ok: false, reason: toGeminiFailure(response.status), detail, status: response.status };
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
    if (typeof text !== "string") {
      return { ok: false, reason: "malformed-response", detail: "response had no candidate text" };
    }
    return { ok: true, data: text };
  } catch (err) {
    return { ok: false, reason: "malformed-response", detail: err instanceof Error ? err.message : "couldn't parse response JSON" };
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown network error";
    logGeminiFailure("generateStream", undefined, detail);
    return { ok: false, reason: "network-error", detail };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    logGeminiFailure("generateStream", response.status, detail);
    return { ok: false, reason: toGeminiFailure(response.status), detail, status: response.status };
  }
  if (!response.body) {
    logGeminiFailure("generateStream", response.status, "response had no body");
    return { ok: false, reason: "malformed-response", detail: "response had no body", status: response.status };
  }

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

/** Extracts the text delta from one `data: {...}` SSE line, or "" if there isn't one. */
function extractLineText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return "";

  try {
    const parsed = JSON.parse(payload);
    return (
      parsed?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text ?? "")
        .join("") ?? ""
    );
  } catch {
    // A single malformed SSE frame doesn't invalidate the rest of the stream.
    return "";
  }
}

/** Parses `data: {...}` SSE lines from Gemini's stream into plain text chunks. */
function toTextDeltaStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A single upstream read() can land on a chunk boundary that completes
      // no line at all (e.g. mid-frame, or — critically — the very last
      // frame if the connection closes before its trailing "\n\n" arrives).
      // Returning from pull() in that case without enqueuing anything and
      // without closing leaves the consumer's pending read() promise stuck
      // forever: nothing else ever re-triggers pull(). So keep reading from
      // upstream within this single pull() call until real progress is
      // made — something enqueued, or the source is actually exhausted.
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          const rest = buffer;
          buffer = "";
          const text = extractLineText(rest);
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let enqueuedAny = false;
        for (const line of lines) {
          const text = extractLineText(line);
          if (text) {
            controller.enqueue(encoder.encode(text));
            enqueuedAny = true;
          }
        }
        if (enqueuedAny) return;
        // Nothing extractable yet (blank lines, or the chunk ended mid-line)
        // — loop back and pull more from upstream instead of returning
        // empty-handed.
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

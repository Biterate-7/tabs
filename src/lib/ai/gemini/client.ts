import "server-only";
import { geminiApiKey, hasGeminiKey } from "@/lib/ai/config";
import type { GeminiResult } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_TIMEOUT_MS = 10000;
const MAX_EMBED_BATCH = 100;

const MAX_LOGGED_DETAIL_CHARS = 500;

function toGeminiFailure(status: number): "rate-limited" | "gemini-error" {
  return status === 429 ? "rate-limited" : "gemini-error";
}

/**
 * Classifies a caught fetch/read error as a deliberate timeout vs. any
 * other network failure. Checks `.name` directly rather than requiring
 * `instanceof Error` — the DOMException our own timers construct (and the
 * one AbortSignal.timeout() produces) both expose `.name` without
 * necessarily satisfying `instanceof Error` in every runtime.
 */
function classifyFetchError(err: unknown): "timeout" | "network-error" {
  const name = err && typeof err === "object" && "name" in err ? (err as { name?: unknown }).name : undefined;
  return name === "TimeoutError" ? "timeout" : "network-error";
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
 * front of the browser.
 */
function logGeminiFailure(op: string, status: number | undefined, detail: string): void {
  console.error(`[gemini:${op}] request failed${status ? ` (HTTP ${status})` : ""}: ${detail || "(no detail)"}`);
}

/**
 * Embeds up to MAX_EMBED_BATCH texts in one request via batchEmbedContents.
 * Callers are responsible for chunking larger batches — this never splits
 * internally so the caller's own concurrency limiter stays in control. This
 * is the only remaining Gemini call in the app — it powers Auto-Organize's
 * optional semantic clustering hints (see src/lib/ai/cluster.ts); there is
 * no text-generation/chat call left.
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
    return { ok: false, reason: classifyFetchError(err), detail };
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

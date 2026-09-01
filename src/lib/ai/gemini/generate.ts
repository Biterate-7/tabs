import "server-only";
import { geminiApiKey, hasGeminiKey } from "@/lib/ai/config";
import type { GeminiResult } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GENERATE_TIMEOUT_MS = 20000;
const MAX_LOGGED_DETAIL_CHARS = 500;

function toGeminiFailure(status: number): "rate-limited" | "gemini-error" {
  return status === 429 ? "rate-limited" : "gemini-error";
}

function classifyFetchError(err: unknown): "timeout" | "network-error" {
  const name = err && typeof err === "object" && "name" in err ? (err as { name?: unknown }).name : undefined;
  return name === "TimeoutError" ? "timeout" : "network-error";
}

async function readErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message) return message.slice(0, MAX_LOGGED_DETAIL_CHARS);
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return raw.slice(0, MAX_LOGGED_DETAIL_CHARS);
}

function logGeminiFailure(op: string, status: number | undefined, detail: string): void {
  console.error(`[gemini:${op}] request failed${status ? ` (HTTP ${status})` : ""}: ${detail || "(no detail)"}`);
}

/**
 * Calls Gemini's generateContent with `responseMimeType: "application/json"`
 * and returns the parsed JSON body of the model's response — the caller is
 * responsible for validating the specific shape (this function only
 * guarantees the response was well-formed JSON, not that it matches any
 * particular schema). This is TabDump's only text-generation Gemini call,
 * powering src/lib/sections/ai/organize.ts's batch section-organization
 * step; embedTexts (src/lib/ai/gemini/client.ts) remains the only embedding
 * call. Same server-only/timeout/typed-failure-result contract as
 * embedTexts, so both share one error-handling story for callers.
 */
export async function generateJSON(prompt: string, model: string): Promise<GeminiResult<unknown>> {
  if (!hasGeminiKey()) return { ok: false, reason: "missing-key" };

  const url = `${API_BASE}/models/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  };

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
    return { ok: false, reason: classifyFetchError(err), detail };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    logGeminiFailure("generate", response.status, detail);
    return { ok: false, reason: toGeminiFailure(response.status), detail, status: response.status };
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      return { ok: false, reason: "malformed-response", detail: "response had no candidate text" };
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, reason: "malformed-response", detail: "candidate text was not valid JSON" };
    }
  } catch (err) {
    return { ok: false, reason: "malformed-response", detail: err instanceof Error ? err.message : "couldn't parse response JSON" };
  }
}

import "server-only";
import { embeddingModel } from "@/lib/ai/config";
import { embedTextsCached } from "@/lib/ai/server/embed-cache";
import { checkAiRateLimit } from "@/lib/ai/server/rate-limit";

export const runtime = "nodejs";

const MAX_TEXTS = 100;
const MAX_TEXT_CHARS = 2000;
// Each call already batches up to MAX_TEXTS texts, and indexing itself
// chunks a workspace into rounds of ~40 texts (see indexer.ts) — 40
// requests/10min per IP comfortably covers reindexing several large
// workspaces in one sitting while still capping a runaway/abusive caller.
const RATE_LIMIT = { limit: 40, windowMs: 10 * 60 * 1000 };

const ERROR_STATUS: Record<string, number> = {
  "missing-key": 503,
  "rate-limited": 429,
  "network-error": 502,
  timeout: 504,
  "gemini-error": 502,
  "malformed-response": 502,
};

const ERROR_MESSAGE: Record<string, string> = {
  "missing-key": "AI features aren't configured yet.",
  "rate-limited": "Too many requests right now — try again shortly.",
  "network-error": "Couldn't reach the AI service.",
  timeout: "Gemini took too long to respond — try again.",
  "gemini-error": "The AI service returned an error.",
  "malformed-response": "The AI service returned something we couldn't parse.",
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const texts = (body as { texts?: unknown } | null)?.texts;
  if (!isStringArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
    return Response.json({ error: "Expected { texts: string[] } (1-100 items)." }, { status: 400 });
  }

  const rate = checkAiRateLimit(request, "embed", RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: ERROR_MESSAGE["rate-limited"], detail: "Per-IP AI rate limit reached — try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } }
    );
  }

  const capped = texts.map((t) => t.slice(0, MAX_TEXT_CHARS));
  const result = await embedTextsCached(capped, embeddingModel());

  if (!result.ok) {
    return Response.json(
      { error: ERROR_MESSAGE[result.reason], detail: result.detail },
      { status: ERROR_STATUS[result.reason] }
    );
  }

  return Response.json({ embeddings: result.data });
}

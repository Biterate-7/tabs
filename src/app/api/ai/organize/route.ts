import "server-only";
import { generationModel } from "@/lib/ai/config";
import { generateJSON } from "@/lib/ai/gemini/generate";
import { checkAiRateLimit } from "@/lib/ai/server/rate-limit";

export const runtime = "nodejs";

const MAX_PROMPT_CHARS = 20000;
// One dump's worth of organize calls (see MAX_CHUNK_TABS in sections/ai/organize.ts,
// a large dump chunks into a handful of sequential requests) plus headroom
// for a couple of manual "Reorganize" reruns in the same session.
const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: `Expected { prompt: string } (1-${MAX_PROMPT_CHARS} chars).` }, { status: 400 });
  }

  const rate = checkAiRateLimit(request, "organize", RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: ERROR_MESSAGE["rate-limited"], detail: "Per-IP AI rate limit reached — try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } }
    );
  }

  const result = await generateJSON(prompt, generationModel());

  if (!result.ok) {
    return Response.json(
      { error: ERROR_MESSAGE[result.reason], detail: result.detail },
      { status: ERROR_STATUS[result.reason] }
    );
  }

  return Response.json({ data: result.data });
}

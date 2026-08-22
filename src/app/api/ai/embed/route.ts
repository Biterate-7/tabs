import "server-only";
import { embedTexts } from "@/lib/ai/gemini/client";
import { embeddingModel } from "@/lib/ai/config";

export const runtime = "nodejs";

const MAX_TEXTS = 100;
const MAX_TEXT_CHARS = 2000;

const ERROR_STATUS: Record<string, number> = {
  "missing-key": 503,
  "rate-limited": 429,
  "network-error": 502,
  "gemini-error": 502,
  "malformed-response": 502,
};

const ERROR_MESSAGE: Record<string, string> = {
  "missing-key": "AI features aren't configured yet.",
  "rate-limited": "Too many requests right now — try again shortly.",
  "network-error": "Couldn't reach the AI service.",
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

  const capped = texts.map((t) => t.slice(0, MAX_TEXT_CHARS));
  const result = await embedTexts(capped, embeddingModel());

  if (!result.ok) {
    return Response.json(
      { error: ERROR_MESSAGE[result.reason] },
      { status: ERROR_STATUS[result.reason] }
    );
  }

  return Response.json({ embeddings: result.data });
}

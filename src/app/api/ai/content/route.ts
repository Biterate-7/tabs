import "server-only";
import { runWithConcurrency } from "@/lib/titles/concurrency";
import { isSafeToFetch } from "@/lib/titles/ssrf-guard";
import { extractPageContent } from "@/lib/ai/extract-text";
import type { ContentApiResult } from "@/lib/ai/types";

export const runtime = "nodejs";

const MAX_BATCH = 20;
const SERVER_CONCURRENCY = 4;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function extractOne(url: string): Promise<ContentApiResult> {
  if (!isSafeToFetch(url)) return { url, ok: false };

  const extracted = await extractPageContent(url);
  if (!extracted) return { url, ok: false };

  return { url, ok: true, description: extracted.description, text: extracted.text };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const urls = (body as { urls?: unknown } | null)?.urls;
  if (!isStringArray(urls)) {
    return Response.json({ error: "Expected { urls: string[] }." }, { status: 400 });
  }

  const batch = urls.slice(0, MAX_BATCH);
  const results = await runWithConcurrency(batch, SERVER_CONCURRENCY, extractOne);

  return Response.json({
    results: results.map((result, index): ContentApiResult => result ?? { url: batch[index], ok: false }),
  });
}

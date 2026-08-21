import "server-only";
import { runWithConcurrency } from "@/lib/titles/concurrency";
import { isSafeToFetch } from "@/lib/titles/ssrf-guard";
import { resolveTitle } from "@/lib/titles/server/registry";
import type { TitleApiResult } from "@/lib/titles/types";

export const runtime = "nodejs";

const MAX_BATCH = 50;
const SERVER_CONCURRENCY = 6;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function resolveOne(url: string): Promise<TitleApiResult> {
  if (!isSafeToFetch(url)) {
    return { url, ok: false, reason: "invalid-url", permanent: true };
  }

  const result = await resolveTitle(url);
  return result.ok
    ? { url, ok: true, title: result.title, source: result.source }
    : { url, ok: false, reason: result.reason, permanent: result.permanent };
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

  // A well-behaved client already chunks batches (see client/queue.ts); an
  // over-sized batch is truncated rather than rejected outright.
  const batch = urls.slice(0, MAX_BATCH);

  const results = await runWithConcurrency(batch, SERVER_CONCURRENCY, resolveOne);

  return Response.json({
    results: results.map(
      (result, index): TitleApiResult =>
        result ?? { url: batch[index], ok: false, reason: "network-error", permanent: false }
    ),
  });
}

import { runWithConcurrency } from "@/lib/titles/concurrency";
import type { ContentApiResult } from "./types";

const BATCH_SIZE = 15;
const CONCURRENCY = 3;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchBatch(urls: string[]): Promise<Map<string, ContentApiResult>> {
  const byUrl = new Map<string, ContentApiResult>();
  try {
    const response = await fetch("/api/ai/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (!response.ok) throw new Error(`content API responded ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.results)) throw new Error("malformed content API response");
    for (const result of data.results as ContentApiResult[]) byUrl.set(result.url, result);
  } catch {
    // Whole batch failed — those URLs are simply absent from the returned
    // map, and the indexer treats "absent" the same as an explicit failure.
  }
  return byUrl;
}

/** Fetches extracted page content for `urls`, batched with bounded concurrency. Never rejects. */
export async function extractContentForUrls(urls: string[]): Promise<Map<string, ContentApiResult>> {
  const unique = Array.from(new Set(urls));
  if (unique.length === 0) return new Map();

  const batches = chunk(unique, BATCH_SIZE);
  const byUrl = new Map<string, ContentApiResult>();

  await runWithConcurrency(batches, CONCURRENCY, async (batch) => {
    const result = await fetchBatch(batch);
    for (const [url, r] of result) byUrl.set(url, r);
  });

  return byUrl;
}

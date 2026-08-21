import type { TitleApiResult } from "@/lib/titles/types";
import { runWithConcurrency } from "@/lib/titles/concurrency";

const BATCH_SIZE = 8;
const CLIENT_CONCURRENCY = 4;

// Module-level: shared across every call so overlapping requests for the
// same URL (e.g. two duplicate tabs, or a re-render firing mid-flight) can
// attach to one in-progress request instead of firing a second one.
const inFlight = new Map<string, Promise<TitleApiResult>>();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function networkErrorResult(url: string): TitleApiResult {
  return { url, ok: false, reason: "network-error", permanent: false };
}

async function fetchBatch(urls: string[]): Promise<Map<string, TitleApiResult>> {
  const byUrl = new Map<string, TitleApiResult>();

  try {
    const response = await fetch("/api/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (!response.ok) throw new Error(`titles API responded ${response.status}`);

    const data = await response.json();
    if (!data || !Array.isArray(data.results)) throw new Error("malformed titles API response");

    for (const result of data.results as TitleApiResult[]) {
      byUrl.set(result.url, result);
    }
  } catch {
    // The whole request failed (network down, non-200, bad JSON). Every URL
    // in this batch is simply "unresolved" — the UI already has a domain
    // fallback ready, so no error needs to surface anywhere.
  }

  return byUrl;
}

/**
 * Resolves titles for `urls` via /api/titles: batches them, runs batches
 * through a bounded-concurrency limiter, and de-duplicates in-flight
 * requests so concurrent callers asking about the same URL share one
 * network call. Never rejects — every URL always gets a result, success or
 * a typed failure.
 */
export async function requestTitles(urls: string[]): Promise<TitleApiResult[]> {
  const unique = Array.from(new Set(urls));
  if (unique.length === 0) return [];

  // Capture a stable reference to each URL's result promise synchronously,
  // before any `await` runs, so nothing can remove an entry out from under
  // an overlapping caller between "look it up" and "use it."
  const resultPromises = new Map<string, Promise<TitleApiResult>>();
  const newUrls: string[] = [];

  for (const url of unique) {
    const existing = inFlight.get(url);
    if (existing) {
      resultPromises.set(url, existing);
    } else {
      newUrls.push(url);
    }
  }

  const chunks = chunk(newUrls, BATCH_SIZE);
  const chunkWork = chunks.map((batchUrls) => {
    const batchDeferred = deferred<Map<string, TitleApiResult>>();
    for (const url of batchUrls) {
      const promise = batchDeferred.promise.then((byUrl) => byUrl.get(url) ?? networkErrorResult(url));
      inFlight.set(url, promise);
      resultPromises.set(url, promise);
    }
    return { batchUrls, batchDeferred };
  });

  const runPromise = runWithConcurrency(chunkWork, CLIENT_CONCURRENCY, async ({ batchUrls, batchDeferred }) => {
    const byUrl = await fetchBatch(batchUrls);
    batchDeferred.resolve(byUrl);
    for (const url of batchUrls) inFlight.delete(url);
  });

  const [orderedResults] = await Promise.all([
    Promise.all(unique.map((url) => resultPromises.get(url)!)),
    runPromise,
  ]);

  const byUrl = new Map(unique.map((url, i) => [url, orderedResults[i]]));
  return urls.map((url) => byUrl.get(url)!);
}

/** Test-only: clears in-flight bookkeeping between test cases. */
export function __resetTitleQueueForTests(): void {
  inFlight.clear();
}

import "server-only";
import { checkAiRateLimit } from "@/lib/ai/server/rate-limit";
import { extractSource } from "@/lib/resources/server/extract";
import { isSafeOpenUrl } from "@/lib/browser/protocol";
import { RESOURCE_KINDS } from "@/lib/resources/types";
import type { ResourceKind } from "@/lib/resources/types";

export const runtime = "nodejs";
// A 15 MB PDF can take a while to parse; well within Vercel's function limit.
export const maxDuration = 60;

/**
 * Reads one project source (Hubble 2.0) — a web page, a PDF, a YouTube
 * video's public metadata — for the person who added it.
 *
 * Takes an address and nothing else: no cookies or credentials are forwarded,
 * so it reads exactly what the public web serves. Nothing is stored here; the
 * content goes back to the browser, which keeps it on the device.
 */

/**
 * Unauthenticated, cookie-free and stateless, so the desktop app (served from
 * its own origin) reads sources through the deployed route like the favicon
 * resolver does: the client sends a CORS-simple request (a text/plain body),
 * and every answer allows any origin. No credential is ever accepted here.
 */
const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" } as const;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...CORS, ...init.headers } });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
}

// Enough for a 100-source project to be read in one sitting, per address.
const RATE_LIMIT = { limit: 200, windowMs: 10 * 60 * 1000 };

export async function POST(request: Request): Promise<Response> {
  const limited = checkAiRateLimit(request, "resources-extract", RATE_LIMIT);
  if (!limited.allowed) {
    return json(
      { ok: false, error: { code: "unreachable", message: "Too many sources read at once — Hubble will retry shortly.", retryable: true } },
      { status: 429, headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: "Malformed JSON body." }, { status: 400 });
  }
  const url = (body as { url?: unknown } | null)?.url;
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (!isSafeOpenUrl(url)) return json({ error: "Expected { url: an http(s) address }." }, { status: 400 });

  const result = await extractSource(url, RESOURCE_KINDS.includes(kind as ResourceKind) ? { kind: kind as ResourceKind } : {});
  return json(result);
}

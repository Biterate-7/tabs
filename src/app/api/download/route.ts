import "server-only";
import { handleDownloadRequest } from "@/lib/downloads/endpoint";
import { getDownloadCounter } from "@/lib/downloads/counter-server";
import { getLatestDesktopRelease } from "@/lib/desktop/release-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hubble Desktop's download link: counts the download, then redirects to the
 * published GitHub Release asset. See src/lib/downloads/endpoint.ts for what
 * is counted, what is refused, and why the destination cannot be chosen by
 * the request.
 */
export function GET(request: Request): Promise<Response> {
  return handleDownloadRequest(request, { counter: getDownloadCounter, release: () => getLatestDesktopRelease() });
}

/** The same redirect for link checkers, counting nothing. */
export function HEAD(request: Request): Promise<Response> {
  return handleDownloadRequest(request, { counter: getDownloadCounter, release: () => getLatestDesktopRelease() });
}

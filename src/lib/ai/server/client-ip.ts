import "server-only";

/** Best-effort client IP from standard proxy headers — good enough for the lightweight, best-effort rate limiting in ./rate-limit.ts. Falls back to a shared bucket when nothing is present (e.g. local dev without a proxy in front). */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

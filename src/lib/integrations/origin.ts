/**
 * The origin a request was addressed to — this deployment's issuer and the
 * base of its MCP resource URL.
 *
 * Derived per request rather than configured, deliberately: a preview
 * deployment and production are different authorization servers with
 * different audiences, and a token issued by one must not be accepted by
 * the other. On Vercel the forwarded headers are set by the platform's own
 * edge; elsewhere the request URL is the authority.
 *
 * Only the first value of a forwarded header counts (the hop closest to the
 * client), the scheme is restricted to http/https, and a host is accepted
 * only in hostname[:port] form — so a forged header cannot produce an issuer
 * with a path, credentials or another scheme in it.
 */
const HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function first(value: string | null): string | undefined {
  const head = value?.split(",")[0]?.trim();
  return head ? head : undefined;
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = first(request.headers.get("x-forwarded-host")) ?? first(request.headers.get("host")) ?? url.host;
  const proto = first(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  if (!HOST.test(host) || (proto !== "https" && proto !== "http")) return url.origin;
  return `${proto}://${host.toLowerCase()}`;
}

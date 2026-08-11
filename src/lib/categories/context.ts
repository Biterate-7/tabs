import type { UrlContext } from "./types";

export function toUrlContext(normalizedUrl: string): UrlContext {
  const url = new URL(normalizedUrl);
  return {
    hostname: url.hostname.toLowerCase(),
    pathname: url.pathname.toLowerCase(),
    search: url.search.toLowerCase(),
    href: normalizedUrl.toLowerCase(),
  };
}

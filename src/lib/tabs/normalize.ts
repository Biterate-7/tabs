export const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
] as const;

export function normalizeUrl(url: URL): string {
  const clone = new URL(url.toString());
  clone.hostname = clone.hostname.toLowerCase();
  clone.hash = "";
  for (const param of TRACKING_PARAMS) {
    clone.searchParams.delete(param);
  }
  clone.searchParams.sort();

  const pathname = clone.pathname.replace(/\/+$/, "");
  const search = clone.searchParams.toString();

  return `${clone.protocol}//${clone.hostname}${pathname}${search ? `?${search}` : ""}`;
}

/**
 * The one normalisation every favicon path shares: the client's cache key,
 * the `?host=` it sends, and the host the server agrees to look up are all
 * this function's output, so the same site can never be cached under two
 * spellings or refused by one side and requested by the other.
 *
 * Input is a `Tab.domain` — the URL's hostname minus a leading "www." (see
 * src/lib/tabs/parse.ts) — and the key keeps every other label intact:
 * `console.cloud.google.com` is its own site, never folded into
 * `cloud.google.com` or `google.com`. They serve different icons.
 */

/**
 * Names that never resolve on the public internet, so there is nothing a
 * favicon lookup could find — and, for the local ones, nothing a server
 * should be asked to reach: RFC 2606/6761 (example, invalid, localhost,
 * test), mDNS (local, RFC 6762), home.arpa (RFC 8375), ICANN's reserved
 * `internal`, Tor's `onion`, and the de-facto private `lan`/`localdomain`.
 */
const NON_PUBLIC_SUFFIX = /(^|\.)(example|invalid|localhost|test|local|internal|localdomain|lan|home\.arpa|onion)$/;

/** One DNS label: 1–63 chars, alphanumeric at both ends. `_` appears in real hostnames, so it is allowed. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * The normalised favicon host for `domain`, or null when no lookup should be
 * made for it at all: malformed input, a single-label name, an IP literal,
 * or a non-public suffix. Null means "render the letter fallback, request
 * nothing" — the same outcome the old reserved-TLD check produced.
 */
export function faviconHostKey(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return null;

  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // No real TLD is numeric, so an all-digit last label is an IPv4 literal
  // (IPv6 literals already failed LABEL on their colons/brackets).
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  if (NON_PUBLIC_SUFFIX.test(host)) return null;

  return host;
}

/**
 * Blocks title resolution from being used as an open proxy against internal
 * or local infrastructure. `/api/titles` fetches whatever URL a client sends
 * it, so every URL must clear this check before any resolver touches it.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "metadata.google.internal"]);

function isBlockedIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 0) return true;
  return false;
}

function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

export function isSafeToFetch(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (hostname.endsWith(".local")) return false;
  if (isBlockedIPv4(hostname)) return false;
  if (isBlockedIPv6(hostname)) return false;

  return true;
}

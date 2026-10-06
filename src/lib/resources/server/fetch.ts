import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isSafeToFetch } from "@/lib/titles/ssrf-guard";

/**
 * A fetch for reading a source on the person's behalf: bounded in time and
 * size, and never a proxy into a private network.
 *
 * The title resolver checks only the address it was given and then lets
 * `fetch` follow redirects on its own — so a public page that redirects to
 * `http://169.254.169.254/` would be followed. This follows redirects by hand
 * and checks every hop, including where its hostname actually resolves, so a
 * public name pointing at a private address is refused too.
 */

export type FetchedBytes =
  | { ok: true; finalUrl: string; status: number; contentType: string; bytes: Uint8Array; truncated: boolean }
  | { ok: false; reason: "unsafe" | "timeout" | "network" | "too-many-redirects" };

const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; HubbleReader/1.0; reads pages a person added to their Hubble project)";

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

export async function resolvesPublicly(url: string): Promise<boolean> {
  if (!isSafeToFetch(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const answers = await lookup(host, { all: true });
    return answers.length > 0 && answers.every((answer) => !isPrivateAddress(answer.address));
  } catch {
    // Unresolvable: let fetch report it as a network failure rather than calling it unsafe.
    return true;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - received));
        received = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export async function fetchBytes(
  url: string,
  options: { accept: string; maxBytes: number; timeoutMs: number; check?: (url: string) => Promise<boolean> }
): Promise<FetchedBytes> {
  const check = options.check ?? resolvesPublicly;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await check(current))) return { ok: false, reason: "unsafe" };
      const response = await fetch(current, { signal, redirect: "manual", headers: { "user-agent": USER_AGENT, accept: options.accept } });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        response.body?.cancel().catch(() => {});
        current = new URL(response.headers.get("location")!, current).toString();
        continue;
      }
      const { bytes, truncated } = await readCapped(response, options.maxBytes);
      return { ok: true, finalUrl: current, status: response.status, contentType: response.headers.get("content-type") ?? "", bytes, truncated };
    }
    return { ok: false, reason: "too-many-redirects" };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  }
}

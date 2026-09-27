import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";
import { faviconHostKey } from "../host";
import { isPublicAddress } from "./address";

/**
 * The only way the favicon resolver touches the network.
 *
 * Built on node:http/https rather than global fetch for one reason: the
 * `lookup` hook. It runs inside the socket's own connect, so the address
 * checked is the address connected to — a DNS answer cannot change between
 * the check and the connection (rebinding), and a hostname that resolves to
 * a private address is refused however public its name looks. fetch()
 * exposes no such hook without an extra dependency.
 *
 * Every hop is re-validated, redirects included: http/https only, default
 * port only, no credentials in the URL, and a public hostname as
 * ./host.ts defines it (which also refuses IP literals, since those skip
 * the lookup hook entirely).
 */

export type SafeFetchOptions = {
  /** Sent as the Accept header. */
  accept: string;
  /** Decoded-body cap. */
  maxBytes: number;
  /** When the cap is hit: keep what was read (HTML head scanning) or fail (images). */
  onOverflow: "truncate" | "fail";
  /** Stops reading early once this returns true for the body so far — e.g. `</head>` seen. */
  stopWhen?: (bodySoFar: Buffer) => boolean;
  /** Per-hop deadline. */
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
};

export type SafeFetchResult =
  | { ok: true; url: string; status: number; contentType: string; body: Buffer }
  | { ok: false; reason: "blocked" | "no-such-host" | "timeout" | "network" | "too-large" | "too-many-redirects" };

export type SafeFetcher = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;

type AddressLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const USER_AGENT = `Mozilla/5.0 (compatible; HubbleFaviconBot/1.0; +${CANONICAL_PRODUCTION_ORIGIN})`;
const DEFAULT_MAX_REDIRECTS = 4;

class BlockedError extends Error {
  code = "EHUBBLEBLOCKED";
}

const systemLookup: AddressLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Returns the URL when it may be requested at all, before any DNS is involved. */
export function checkRequestUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // Only the default port: a favicon has no business on :22, :6379 or an admin panel's :8080.
  if (url.port !== "") return null;
  if (faviconHostKey(url.hostname) === null) return null;
  return url;
}

export function createSafeFetcher(
  deps: {
    lookup?: AddressLookup;
    isAllowedAddress?: (address: string) => boolean;
    /** Tests only: the TCP port to dial, since a test server can't sit on 80/443. URLs still must use the default port. */
    connectPort?: number;
  } = {}
): SafeFetcher {
  const resolveAddresses = deps.lookup ?? systemLookup;
  const isAllowed = deps.isAllowedAddress ?? isPublicAddress;

  const guardedLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolveAddresses(hostname).then(
      (addresses) => {
        // Every answer must be public, not just the first: the socket may
        // fall through to any of them (happy eyeballs).
        if (addresses.length === 0 || addresses.some((entry) => !isAllowed(entry.address))) {
          callback(new BlockedError(`${hostname} resolves to a non-public address`));
          return;
        }
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error) => callback(error)
    );
  }) as unknown as LookupFunction;

  function requestOnce(url: URL, options: SafeFetchOptions): Promise<SafeFetchResult | { redirect: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: SafeFetchResult | { redirect: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, {
        method: "GET",
        lookup: guardedLookup,
        ...(deps.connectPort ? { port: deps.connectPort } : {}),
        // A fresh connection per request: a pooled socket was validated for
        // whatever host opened it, and must not be reused on trust.
        agent: false,
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept,
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
      });

      const timer = setTimeout(() => {
        finish({ ok: false, reason: "timeout" });
        request.destroy();
      }, options.timeoutMs);
      const onAbort = () => {
        finish({ ok: false, reason: "timeout" });
        request.destroy();
      };
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      request.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          reason: error.code === "EHUBBLEBLOCKED" ? "blocked" : error.code === "ENOTFOUND" ? "no-such-host" : "network",
        });
      });

      request.on("response", (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          // Parsed here, inside an event handler, so a malformed Location must
          // not throw: that would be an uncaught exception, not a failed fetch.
          let target: string | null = null;
          try {
            target = new URL(location, url).toString();
          } catch {
            // Handled as a network failure below.
          }
          finish(target ? { redirect: target } : { ok: false, reason: "network" });
          request.destroy();
          return;
        }

        const declaredLength = Number(response.headers["content-length"]);
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
        if (options.onOverflow === "fail" && !encoding && declaredLength > options.maxBytes) {
          finish({ ok: false, reason: "too-large" });
          request.destroy();
          return;
        }

        let stream: Readable = response;
        if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = response.pipe(zlib.createInflate());
        else if (encoding === "br") stream = response.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let received = 0;
        const done = () =>
          finish({
            ok: true,
            url: url.toString(),
            status,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          });

        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (received + chunk.length > options.maxBytes) {
            if (options.onOverflow === "fail") {
              finish({ ok: false, reason: "too-large" });
            } else {
              chunks.push(chunk.subarray(0, options.maxBytes - received));
              received = options.maxBytes;
              done();
            }
            request.destroy();
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
          if (options.stopWhen?.(Buffer.concat(chunks))) {
            done();
            request.destroy();
          }
        });
        stream.on("end", done);
        stream.on("error", () => finish({ ok: false, reason: "network" }));
      });

      request.end();
    });
  }

  return async function safeFetch(raw, options) {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let current = raw;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = checkRequestUrl(current);
      if (!url) return { ok: false, reason: "blocked" };
      const result = await requestOnce(url, options);
      if (!("redirect" in result)) return result;
      current = result.redirect;
    }
    return { ok: false, reason: "too-many-redirects" };
  };
}

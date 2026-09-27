// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "../__fixtures__/icons";
import { checkRequestUrl, createSafeFetcher, type SafeFetchOptions } from "./safe-fetch";

/**
 * Exercises the real node:http path against a local server. The server
 * lives on 127.0.0.1, which the production guard (correctly) refuses, so
 * the "allowed" tests inject a resolver mapping public-looking names to it,
 * an address policy that admits it, and its port — while the guard tests use the
 * default policy to prove the same connection is refused.
 */

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/icon.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
    } else if (path === "/gzip.png") {
      response.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      response.end(zlib.gzipSync(PNG));
    } else if (path === "/huge.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(10_000_000) });
      response.end();
    } else if (path === "/stream-huge.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(300_000));
    } else if (path === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(`<html><head><link rel="icon" href="/icon.png"></head>`);
      // Never ends: the reader must stop on </head> without waiting.
    } else if (path === "/slow") {
      // Never responds.
    } else if (path === "/to-metadata") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    } else if (path === "/to-port") {
      response.writeHead(302, { location: "http://public.test-site.com:8080/icon.png" });
      response.end();
    } else if (path === "/to-icon") {
      response.writeHead(301, { location: "/icon.png" });
      response.end();
    } else if (path === "/bad-location") {
      // Raw socket write: Node's own writeHead refuses to send this header.
      request.socket.end("HTTP/1.1 302 Found\r\nLocation: http://[not-a-host/\r\nContent-Length: 0\r\n\r\n");
    } else if (path === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** A fetcher that sends `public.test-site.com` to the local server, through the real lookup hook. */
function localFetcher(isAllowedAddress?: (address: string) => boolean) {
  const fetcher = createSafeFetcher({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    isAllowedAddress: isAllowedAddress ?? (() => true),
    connectPort: port,
  });
  return (path: string, options: Partial<SafeFetchOptions> = {}) =>
    fetcher(`http://public.test-site.com${path}`, {
      accept: "*/*",
      maxBytes: 256 * 1024,
      onOverflow: "fail",
      timeoutMs: 1500,
      ...options,
    });
}

describe("checkRequestUrl", () => {
  it("admits only default-port http(s) URLs on public hostnames", () => {
    expect(checkRequestUrl("https://console.cloud.google.com/favicon.ico")).not.toBeNull();
    expect(checkRequestUrl("http://example.org/")).not.toBeNull();
    for (const url of [
      "ftp://example.org/icon.png",
      "file:///etc/passwd",
      "https://user:pw@example.org/",
      "https://example.org:8443/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://localhost/",
      "http://metadata.google.internal/",
      "http://2130706433/",
      "not a url",
    ]) {
      expect(checkRequestUrl(url), url).toBeNull();
    }
  });
});

describe("createSafeFetcher", () => {
  it("fetches a body when the resolved address is allowed", async () => {
    const result = await localFetcher()("/icon.png");
    expect(result).toMatchObject({ ok: true, status: 200, contentType: "image/png" });
    expect(result.ok && Buffer.compare(result.body, PNG)).toBe(0);
  });

  it("refuses to connect when the name resolves to a private address (the default policy)", async () => {
    const fetcher = createSafeFetcher({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], connectPort: port });
    const result = await fetcher("http://public.test-site.com/icon.png", {
      accept: "*/*",
      maxBytes: 1024,
      onOverflow: "fail",
      timeoutMs: 1500,
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("refuses when ANY resolved address is private, not just the first", async () => {
    const fetcher = createSafeFetcher({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    });
    const result = await fetcher("https://mixed.example.org/", { accept: "*/*", maxBytes: 1024, onOverflow: "fail", timeoutMs: 1500 });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("follows a same-site redirect", async () => {
    expect(await localFetcher()("/to-icon")).toMatchObject({ ok: true, status: 200, url: "http://public.test-site.com/icon.png" });
  });

  it("re-validates redirect targets: metadata IPs and non-default ports are refused", async () => {
    expect(await localFetcher()("/to-metadata")).toEqual({ ok: false, reason: "blocked" });
    expect(await localFetcher()("/to-port")).toEqual({ ok: false, reason: "blocked" });
  });

  it("fails cleanly, without throwing, on a malformed Location header", async () => {
    expect(await localFetcher()("/bad-location")).toEqual({ ok: false, reason: "network" });
  });

  it("gives up on a redirect loop", async () => {
    expect(await localFetcher()("/loop")).toEqual({ ok: false, reason: "too-many-redirects" });
  });

  it("decompresses gzip bodies", async () => {
    const result = await localFetcher()("/gzip.png");
    expect(result.ok && Buffer.compare(result.body, PNG)).toBe(0);
  });

  it("refuses an oversized body, by declared length or by what actually arrives", async () => {
    expect(await localFetcher()("/huge.png")).toEqual({ ok: false, reason: "too-large" });
    expect(await localFetcher()("/stream-huge.png")).toEqual({ ok: false, reason: "too-large" });
  });

  it("truncates instead when asked, and stops reading early once the caller has enough", async () => {
    const truncated = await localFetcher()("/stream-huge.png", { maxBytes: 1000, onOverflow: "truncate" });
    expect(truncated.ok && truncated.body.length).toBe(1000);

    const page = await localFetcher()("/page", {
      onOverflow: "truncate",
      stopWhen: (body) => body.toString("latin1").includes("</head>"),
    });
    expect(page.ok && page.body.toString()).toContain(`<link rel="icon" href="/icon.png">`);
  });

  it("times out a server that never answers", async () => {
    const started = Date.now();
    expect(await localFetcher()("/slow", { timeoutMs: 300 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

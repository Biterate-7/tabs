import { describe, expect, it } from "vitest";
import { expectedOrigin, hasJsonContentType, isSameOrigin } from "./origin";

/** Builds a request the way a browser + proxy would present it. `proto: null` means no proxy told us the scheme. */
function req(headers: Record<string, string | null>): Request {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) if (value !== null) h.set(key, value);
  return new Request("https://ignored.example/api/auth/logout", { method: "POST", headers: h });
}

describe("isSameOrigin behind a proxy (production)", () => {
  const proxied = { host: "tabsdump.vercel.app", "x-forwarded-proto": "https" };

  it("accepts the deployment's own origin", () => {
    expect(isSameOrigin(req({ ...proxied, origin: "https://tabsdump.vercel.app" }))).toBe(true);
  });

  it("rejects another site", () => {
    expect(isSameOrigin(req({ ...proxied, origin: "https://evil.example" }))).toBe(false);
  });

  it("rejects a lookalike host and a subdomain", () => {
    expect(isSameOrigin(req({ ...proxied, origin: "https://tabsdump.vercel.app.evil.example" }))).toBe(false);
    expect(isSameOrigin(req({ ...proxied, origin: "https://evil.tabsdump.vercel.app" }))).toBe(false);
  });

  it("rejects the same host over plain http once the scheme is known", () => {
    expect(isSameOrigin(req({ ...proxied, origin: "http://tabsdump.vercel.app" }))).toBe(false);
  });

  it("prefers x-forwarded-host over host, and takes the first entry of each chain", () => {
    const chained = {
      host: "internal.local",
      "x-forwarded-host": "tabsdump.vercel.app, internal.local",
      "x-forwarded-proto": "https, http",
      origin: "https://tabsdump.vercel.app",
    };
    expect(isSameOrigin(req(chained))).toBe(true);
    expect(expectedOrigin(req(chained))).toBe("https://tabsdump.vercel.app");
  });
});

describe("isSameOrigin with no proxy (local development)", () => {
  it("accepts localhost over http", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
  });

  it("accepts 127.0.0.1 over http", () => {
    // Regression: guessing "https" for anything not literally starting with
    // "localhost" made every mutating auth request 403 on this host.
    expect(isSameOrigin(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true);
  });

  it("accepts an IPv6 loopback and a .localhost subdomain over http", () => {
    expect(isSameOrigin(req({ host: "[::1]:3000", origin: "http://[::1]:3000" }))).toBe(true);
    expect(isSameOrigin(req({ host: "app.localhost:3000", origin: "http://app.localhost:3000" }))).toBe(true);
  });

  it("still rejects a different host", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "http://evil.example" }))).toBe(false);
  });

  it("still rejects a different port on the same host", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "http://localhost:3001" }))).toBe(false);
  });

  it("rejects the opaque origin a sandboxed iframe sends", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "null" }))).toBe(false);
  });

  it("rejects a malformed Origin rather than throwing", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "))) not a url" }))).toBe(false);
  });

  it("reports the origin as unknown when nothing states the scheme", () => {
    expect(expectedOrigin(req({ host: "localhost:3000" }))).toBeNull();
  });
});

describe("isSameOrigin edge cases", () => {
  it("allows a request that carries no Origin at all", () => {
    // Not hostile: the browser didn't consider it cross-origin, and
    // non-browser callers (curl, health checks) never send one. The cookie
    // policy, not this header, is what stops the cross-site case.
    expect(isSameOrigin(req({ host: "tabsdump.vercel.app" }))).toBe(true);
  });

  it("allows a request with no host header to identify the target", () => {
    expect(isSameOrigin(req({ origin: "https://anything.example" }))).toBe(true);
  });
});

describe("hasJsonContentType", () => {
  it("accepts application/json, with or without parameters", () => {
    expect(hasJsonContentType(req({ "content-type": "application/json" }))).toBe(true);
    expect(hasJsonContentType(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(hasJsonContentType(req({ "content-type": "APPLICATION/JSON" }))).toBe(true);
  });

  it("rejects the content types a cross-site form post can produce", () => {
    // These three are the entire set a <form> can send without a preflight.
    expect(hasJsonContentType(req({ "content-type": "application/x-www-form-urlencoded" }))).toBe(false);
    expect(hasJsonContentType(req({ "content-type": "multipart/form-data" }))).toBe(false);
    expect(hasJsonContentType(req({ "content-type": "text/plain" }))).toBe(false);
  });

  it("rejects a missing content type", () => {
    expect(hasJsonContentType(req({}))).toBe(false);
  });
});

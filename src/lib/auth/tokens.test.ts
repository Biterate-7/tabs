import { describe, expect, it } from "vitest";
import { createNonce, createRecordId, createSessionToken, hashNonce, hashSessionToken, safeEqual } from "./tokens";

describe("session tokens", () => {
  it("never repeats a token", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => createSessionToken()));
    expect(tokens.size).toBe(500);
  });

  it("carries 256 bits of entropy in a URL-safe encoding", () => {
    const token = createSessionToken();
    // 32 raw bytes -> 43 base64url characters, with no padding and nothing
    // that needs escaping in a cookie value.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically, so a lookup by hash can find the row", () => {
    const token = createSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("never stores anything the raw token can be read back out of", () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different tokens different hashes", () => {
    expect(hashSessionToken(createSessionToken())).not.toBe(hashSessionToken(createSessionToken()));
  });
});

describe("nonces", () => {
  it("never repeats", () => {
    const nonces = new Set(Array.from({ length: 500 }, () => createNonce()));
    expect(nonces.size).toBe(500);
  });

  it("hashes deterministically", () => {
    const nonce = createNonce();
    expect(hashNonce(nonce)).toBe(hashNonce(nonce));
  });
});

describe("createRecordId", () => {
  it("produces a UUID rather than the counter-based ids used elsewhere", () => {
    // lib/id.ts's scheme restarts its counter per process, which would
    // collide across serverless instances — see the doc comment.
    expect(createRecordId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createRecordId()).not.toBe(createRecordId());
  });
});

describe("safeEqual", () => {
  it("matches identical values", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different values of the same length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    // timingSafeEqual itself throws on a length mismatch — the guard in
    // safeEqual is what keeps a malformed input from becoming a 500.
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("handles multi-byte characters without throwing", () => {
    expect(safeEqual("é", "é")).toBe(true);
    expect(safeEqual("é", "e")).toBe(false);
  });
});
